import { AgentMuxError } from './errors.js'
import type {
  AgentHookReceipt,
  AgentMuxRunRef,
  AgentMuxStoredSemanticSession,
  AgentNativeSessionHandle
} from './types.js'

const MAX_STORED_SESSIONS = 256
const MAX_ID_BYTES = 512
const MAX_PATH_BYTES = 16 * 1024

export type AgentMuxSemanticStore = {
  load(): Promise<readonly unknown[]>
  put(session: AgentMuxStoredSemanticSession): Promise<void>
  delete(semanticSessionId: string): Promise<void>
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError(`${name} must be an object.`, 'INVALID_SEMANTIC_STORE')
  }
  return value as Record<string, unknown>
}

function string(value: unknown, name: string, maxBytes = MAX_ID_BYTES): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxBytes || /[\0\r\n]/.test(value)) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_SEMANTIC_STORE')
  }
  return value
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_SEMANTIC_STORE')
  }
  return value as number
}

function runRef(value: unknown): AgentMuxRunRef {
  const source = record(value, 'daemonSession')
  return {
    sessionId: string(source.sessionId, 'daemonSession.sessionId'),
    incarnationId: string(source.incarnationId, 'daemonSession.incarnationId')
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
  throw new AgentMuxError('nativeHandle.kind is invalid.', 'INVALID_SEMANTIC_STORE')
}

function hookReceipt(value: unknown): AgentHookReceipt {
  const source = record(value, 'hookReceipt')
  return {
    id: string(source.id, 'hookReceipt.id'),
    agentId: string(source.agentId, 'hookReceipt.agentId'),
    semanticSessionId: string(source.semanticSessionId, 'hookReceipt.semanticSessionId'),
    daemonSession: runRef(source.daemonSession),
    eventName: string(source.eventName, 'hookReceipt.eventName'),
    observedAt: timestamp(source.observedAt, 'hookReceipt.observedAt')
  }
}

export function normalizeStoredSemanticSession(value: unknown): AgentMuxStoredSemanticSession {
  const source = record(value, 'semantic session')
  if (source.kind !== 'agent') {
    throw new AgentMuxError('Only Agent semantic sessions may be persisted.', 'INVALID_SEMANTIC_STORE')
  }
  const session: AgentMuxStoredSemanticSession = {
    kind: 'agent',
    semanticSessionId: string(source.semanticSessionId, 'semanticSessionId'),
    agentId: string(source.agentId, 'agentId'),
    hostId: string(source.hostId, 'hostId'),
    workspacePath: string(source.workspacePath, 'workspacePath', MAX_PATH_BYTES),
    daemonSession: runRef(source.daemonSession),
    outputCursor: timestamp(source.outputCursor, 'outputCursor'),
    createdAt: timestamp(source.createdAt, 'createdAt'),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
    ...(source.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(source.nativeHandle) }),
    ...(source.hookReceipt === undefined ? {} : { hookReceipt: hookReceipt(source.hookReceipt) })
  }
  if (session.nativeHandle?.kind === 'provider' && session.nativeHandle.providerId !== session.agentId) {
    throw new AgentMuxError('Native session handle provider does not match the Agent.', 'INVALID_SEMANTIC_STORE')
  }
  if (
    session.hookReceipt &&
    (
      session.hookReceipt.agentId !== session.agentId ||
      session.hookReceipt.semanticSessionId !== session.semanticSessionId ||
      session.hookReceipt.daemonSession.sessionId !== session.daemonSession.sessionId ||
      session.hookReceipt.daemonSession.incarnationId !== session.daemonSession.incarnationId
    )
  ) {
    throw new AgentMuxError('Hook receipt does not match the semantic session.', 'INVALID_SEMANTIC_STORE')
  }
  return session
}

export async function loadSemanticSessions(
  store: AgentMuxSemanticStore
): Promise<AgentMuxStoredSemanticSession[]> {
  const values = await store.load()
  if (values.length > MAX_STORED_SESSIONS) {
    throw new AgentMuxError('Semantic session store exceeds its session limit.', 'SEMANTIC_STORE_LIMIT')
  }
  const sessions = values.map(normalizeStoredSemanticSession)
  const ids = new Set<string>()
  for (const session of sessions) {
    if (ids.has(session.semanticSessionId)) {
      throw new AgentMuxError('Semantic session store contains a duplicate id.', 'INVALID_SEMANTIC_STORE')
    }
    ids.add(session.semanticSessionId)
  }
  return sessions
}

export class AgentMuxMemorySemanticStore implements AgentMuxSemanticStore {
  private readonly sessions = new Map<string, AgentMuxStoredSemanticSession>()

  async load(): Promise<readonly unknown[]> {
    return [...this.sessions.values()].map((session) => structuredClone(session))
  }

  async put(session: AgentMuxStoredSemanticSession): Promise<void> {
    const normalized = normalizeStoredSemanticSession(session)
    if (!this.sessions.has(normalized.semanticSessionId) && this.sessions.size >= MAX_STORED_SESSIONS) {
      throw new AgentMuxError('Semantic session store exceeds its session limit.', 'SEMANTIC_STORE_LIMIT')
    }
    this.sessions.set(normalized.semanticSessionId, structuredClone(normalized))
  }

  async delete(semanticSessionId: string): Promise<void> {
    this.sessions.delete(semanticSessionId)
  }
}
