import { AgentMuxError } from './errors.js'
import type {
  AgentHookReceipt,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentNativeSessionHandle
} from './types.js'

const MAX_STORED_SESSIONS = 256
const MAX_ID_BYTES = 512
const MAX_PATH_BYTES = 16 * 1024

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
  return {
    runId: string(source.runId, 'run.runId'),
    incarnationId: string(source.incarnationId, 'run.incarnationId')
  }
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
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: string(source.agentSessionId, 'agentSessionId'),
    agentId: string(source.agentId, 'agentId'),
    hostId: string(source.hostId, 'hostId'),
    workspacePath: string(source.workspacePath, 'workspacePath', MAX_PATH_BYTES),
    run: runRef(source.run),
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
      session.hookReceipt.run.runId !== session.run.runId ||
      session.hookReceipt.run.incarnationId !== session.run.incarnationId
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
  for (const session of sessions) {
    if (ids.has(session.agentSessionId)) {
      throw new AgentMuxError('Agent Session store contains a duplicate id.', 'INVALID_AGENT_SESSION_STORE')
    }
    ids.add(session.agentSessionId)
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
