import { AgentMuxError } from './errors.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultAgentMuxRuntimeDirectory } from './runtime-paths.js'
import type {
  AgentHookReceipt,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentNativeSessionHandle
} from './types.js'

const MAX_STORED_SESSIONS = 256
const MAX_ID_BYTES = 512
const MAX_PATH_BYTES = 16 * 1024
const MAX_RETIRED_RUNS = 16
const MAX_STORE_BYTES = 1024 * 1024
const LOCK_ATTEMPTS = 100
const LOCK_RETRY_MS = 10

export type AgentMuxAgentSessionStore = {
  load(): Promise<readonly unknown[]>
  put(session: AgentMuxStoredAgentSession): Promise<void>
  delete(agentSessionId: string): Promise<void>
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError(`${name} must be an object.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as Record<string, unknown>
}

function string(value: unknown, name: string, maxBytes = MAX_ID_BYTES): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxBytes || /[\0\r\n]/.test(value)) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as number
}

function runRef(value: unknown): AgentMuxRunRef {
  const source = record(value, 'run')
  if (Object.keys(source).length !== 1 || !Object.hasOwn(source, 'runId')) {
    throw new AgentMuxError('run must contain only runId.', 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    runId: string(source.runId, 'run.runId')
  }
}

function retiredRuns(value: unknown, current: AgentMuxRunRef): AgentMuxRunRef[] {
  if (!Array.isArray(value) || value.length > MAX_RETIRED_RUNS) {
    throw new AgentMuxError('retiredRuns is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const runs = value.map(runRef)
  const ids = new Set<string>()
  for (const run of runs) {
    if (run.runId === current.runId || ids.has(run.runId)) {
      throw new AgentMuxError('retiredRuns contains a conflicting Run.', 'INVALID_AGENT_SESSION_STORE')
    }
    ids.add(run.runId)
  }
  return runs
}

function nativeHandle(value: unknown): AgentNativeSessionHandle {
  const source = record(value, 'nativeHandle')
  if (source.kind === 'provider') {
    const transcriptPath = source.transcriptPath === undefined
      ? undefined
      : string(source.transcriptPath, 'nativeHandle.transcriptPath', MAX_PATH_BYTES)
    return {
      kind: 'provider',
      providerId: string(source.providerId, 'nativeHandle.providerId'),
      sessionId: string(source.sessionId, 'nativeHandle.sessionId'),
      ...(transcriptPath ? { transcriptPath } : {})
    }
  }
  if (source.kind === 'acp') {
    return {
      kind: 'acp',
      adapterId: string(source.adapterId, 'nativeHandle.adapterId'),
      sessionId: string(source.sessionId, 'nativeHandle.sessionId')
    }
  }
  throw new AgentMuxError('nativeHandle.kind is invalid.', 'INVALID_AGENT_SESSION_STORE')
}

function hookReceipt(value: unknown): AgentHookReceipt {
  const source = record(value, 'hookReceipt')
  return {
    id: string(source.id, 'hookReceipt.id'),
    agentId: string(source.agentId, 'hookReceipt.agentId'),
    agentSessionId: string(source.agentSessionId, 'hookReceipt.agentSessionId'),
    run: runRef(source.run),
    eventName: string(source.eventName, 'hookReceipt.eventName'),
    observedAt: timestamp(source.observedAt, 'hookReceipt.observedAt')
  }
}

export function normalizeStoredAgentSession(value: unknown): AgentMuxStoredAgentSession {
  const source = record(value, 'Agent Session')
  if (source.kind !== 'agent') {
    throw new AgentMuxError('Only Agent Sessions may be persisted.', 'INVALID_AGENT_SESSION_STORE')
  }
  const currentRun = runRef(source.run)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: string(source.agentSessionId, 'agentSessionId'),
    agentId: string(source.agentId, 'agentId'),
    hostId: string(source.hostId, 'hostId'),
    workspacePath: string(source.workspacePath, 'workspacePath', MAX_PATH_BYTES),
    run: currentRun,
    retiredRuns: retiredRuns(source.retiredRuns, currentRun),
    hookBindingId: string(source.hookBindingId, 'hookBindingId'),
    outputCursorBytes: timestamp(source.outputCursorBytes, 'outputCursorBytes'),
    createdAt: timestamp(source.createdAt, 'createdAt'),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
    ...(source.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(source.nativeHandle) }),
    ...(source.hookReceipt === undefined ? {} : { hookReceipt: hookReceipt(source.hookReceipt) })
  }
  if (session.nativeHandle?.kind === 'provider' && session.nativeHandle.providerId !== session.agentId) {
    throw new AgentMuxError('Native session handle provider does not match the Agent.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (
    session.hookReceipt &&
    (
      session.hookReceipt.agentId !== session.agentId ||
      session.hookReceipt.agentSessionId !== session.agentSessionId ||
      session.hookReceipt.run.runId !== session.run.runId
    )
  ) {
    throw new AgentMuxError('Hook receipt does not match the Agent Session.', 'INVALID_AGENT_SESSION_STORE')
  }
  return session
}

export async function loadAgentSessions(
  store: AgentMuxAgentSessionStore
): Promise<AgentMuxStoredAgentSession[]> {
  const values = await store.load()
  if (values.length > MAX_STORED_SESSIONS) {
    throw new AgentMuxError('Agent Session store exceeds its session limit.', 'AGENT_SESSION_STORE_LIMIT')
  }
  const sessions = values.map(normalizeStoredAgentSession)
  const ids = new Set<string>()
  const runs = new Set<string>()
  const nativeHandles = new Set<string>()
  for (const session of sessions) {
    if (ids.has(session.agentSessionId)) {
      throw new AgentMuxError('Agent Session store contains a duplicate id.', 'INVALID_AGENT_SESSION_STORE')
    }
    if (runs.has(session.run.runId)) {
      throw new AgentMuxError('Agent Session store contains a duplicate Run binding.', 'INVALID_AGENT_SESSION_STORE')
    }
    if (session.retiredRuns.some((run) => runs.has(run.runId))) {
      throw new AgentMuxError('Agent Session store contains a conflicting retired Run.', 'INVALID_AGENT_SESSION_STORE')
    }
    const nativeHandleKey = session.nativeHandle?.kind === 'provider'
      ? JSON.stringify(['provider', session.nativeHandle.providerId, session.nativeHandle.sessionId])
      : session.nativeHandle?.kind === 'acp'
        ? JSON.stringify(['acp', session.nativeHandle.adapterId, session.nativeHandle.sessionId])
        : null
    if (nativeHandleKey && nativeHandles.has(nativeHandleKey)) {
      throw new AgentMuxError('Agent Session store contains a duplicate native binding.', 'INVALID_AGENT_SESSION_STORE')
    }
    ids.add(session.agentSessionId)
    runs.add(session.run.runId)
    for (const run of session.retiredRuns) runs.add(run.runId)
    if (nativeHandleKey) nativeHandles.add(nativeHandleKey)
  }
  return sessions
}

export class AgentMuxMemoryAgentSessionStore implements AgentMuxAgentSessionStore {
  private readonly sessions = new Map<string, AgentMuxStoredAgentSession>()

  async load(): Promise<readonly unknown[]> {
    return [...this.sessions.values()].map((session) => structuredClone(session))
  }

  async put(session: AgentMuxStoredAgentSession): Promise<void> {
    const normalized = normalizeStoredAgentSession(session)
    if (!this.sessions.has(normalized.agentSessionId) && this.sessions.size >= MAX_STORED_SESSIONS) {
      throw new AgentMuxError('Agent Session store exceeds its session limit.', 'AGENT_SESSION_STORE_LIMIT')
    }
    this.sessions.set(normalized.agentSessionId, structuredClone(normalized))
  }

  async delete(agentSessionId: string): Promise<void> {
    this.sessions.delete(agentSessionId)
  }
}

type AgentSessionStoreDocument = {
  version: 1
  sessions: AgentMuxStoredAgentSession[]
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function defaultAgentMuxAgentSessionStorePath(): string {
  return join(defaultAgentMuxRuntimeDirectory(), 'agent-sessions.json')
}

export class AgentMuxFileAgentSessionStore implements AgentMuxAgentSessionStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly path = defaultAgentMuxAgentSessionStorePath()) {}

  async load(): Promise<readonly unknown[]> {
    await this.tail
    return (await this.read()).sessions.map((session) => structuredClone(session))
  }

  async put(session: AgentMuxStoredAgentSession): Promise<void> {
    await this.enqueue(async () => {
      const normalized = normalizeStoredAgentSession(session)
      const document = await this.read()
      const sessions = new Map(document.sessions.map((item) => [item.agentSessionId, item]))
      if (!sessions.has(normalized.agentSessionId) && sessions.size >= MAX_STORED_SESSIONS) {
        throw new AgentMuxError('Agent Session store exceeds its session limit.', 'AGENT_SESSION_STORE_LIMIT')
      }
      sessions.set(normalized.agentSessionId, normalized)
      await this.write({ version: 1, sessions: [...sessions.values()] })
    })
  }

  async delete(agentSessionId: string): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.read()
      document.sessions = document.sessions.filter((session) => session.agentSessionId !== agentSessionId)
      await this.write(document)
    })
  }

  private async read(): Promise<AgentSessionStoreDocument> {
    try {
      const metadata = await stat(this.path)
      if (!metadata.isFile() || metadata.size > MAX_STORE_BYTES) {
        throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const document = value as { version?: unknown; sessions?: unknown }
      if (document.version !== 1 || !Array.isArray(document.sessions)) {
        throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const sessions = await loadAgentSessions({
        async load() { return document.sessions as unknown[] },
        async put() {},
        async delete() {}
      })
      return { version: 1, sessions }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: [] }
      throw error
    }
  }

  private async write(document: AgentSessionStoreDocument): Promise<void> {
    const content = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) {
      throw new AgentMuxError('Agent Session store exceeds its size limit.', 'AGENT_SESSION_STORE_LIMIT')
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' })
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.tail.catch(() => {}).then(async () => {
      const release = await this.acquireLock()
      try {
        await operation()
      } finally {
        await release()
      }
    })
    this.tail = current.then(() => {}, () => {})
    await current
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const path = `${this.path}.lock`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o600)
        await handle.writeFile(`${process.pid}\n`, 'utf8')
        return async () => {
          await handle.close()
          await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await this.removeDeadOwnerLock(path)
        await delay(LOCK_RETRY_MS)
      }
    }
    throw new AgentMuxError('Agent Session store is busy.', 'AGENT_SESSION_STORE_BUSY')
  }

  private async removeDeadOwnerLock(path: string): Promise<void> {
    try {
      const pid = Number((await readFile(path, 'utf8')).trim())
      if (!Number.isSafeInteger(pid) || pid <= 0) return
      try {
        process.kill(pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') await unlink(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
