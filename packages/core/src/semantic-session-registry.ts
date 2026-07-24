import { AgentMuxError } from './errors.js'
import {
  loadSemanticSessions,
  normalizeStoredSemanticSession,
  type AgentMuxSemanticStore
} from './semantic-store.js'
import type { AgentMuxRunRef, AgentMuxSemanticSession } from './types.js'

function sameRun(left: AgentMuxRunRef, right: AgentMuxRunRef): boolean {
  return left.sessionId === right.sessionId && left.incarnationId === right.incarnationId
}

export class AgentMuxSemanticSessionRegistry {
  private readonly sessions = new Map<string, AgentMuxSemanticSession>()
  private readonly semanticIdByDaemonSession = new Map<string, string>()
  private readonly reservations = new Set<string>()
  private readonly writeTails = new Map<string, Promise<void>>()

  constructor(private readonly store: AgentMuxSemanticStore) {}

  async load(hostId: string): Promise<void> {
    await Promise.allSettled(this.writeTails.values())
    const sessions = await loadSemanticSessions(this.store)
    this.sessions.clear()
    this.semanticIdByDaemonSession.clear()
    for (const session of sessions) {
      if (session.hostId === hostId) this.remember(session)
    }
  }

  list(): AgentMuxSemanticSession[] {
    return [...this.sessions.values()].map((session) => structuredClone(session))
  }

  get(semanticSessionId: string): AgentMuxSemanticSession {
    const session = this.sessions.get(semanticSessionId)
    if (!session) {
      throw new AgentMuxError(`Unknown semantic session: ${semanticSessionId}`, 'UNKNOWN_SEMANTIC_SESSION')
    }
    return session
  }

  reserveNew(semanticSessionId: string): () => void {
    if (this.sessions.has(semanticSessionId) || this.reservations.has(semanticSessionId)) {
      throw new AgentMuxError(`Semantic session already exists: ${semanticSessionId}`, 'DUPLICATE_SEMANTIC_SESSION')
    }
    return this.reserve(semanticSessionId)
  }

  reserveExisting(semanticSessionId: string): () => void {
    this.get(semanticSessionId)
    if (this.reservations.has(semanticSessionId)) {
      throw new AgentMuxError('Semantic session already has a lifecycle operation in progress.', 'SEMANTIC_SESSION_BUSY')
    }
    return this.reserve(semanticSessionId)
  }

  async put(
    session: AgentMuxSemanticSession,
    expectedCurrentRun?: AgentMuxRunRef
  ): Promise<AgentMuxSemanticSession> {
    const normalized = normalizeStoredSemanticSession(session)
    return await this.enqueue(normalized.semanticSessionId, async () => {
      const previous = this.sessions.get(normalized.semanticSessionId)
      if (expectedCurrentRun && (!previous || !sameRun(previous.daemonSession, expectedCurrentRun))) {
        throw new AgentMuxError('Semantic session changed before persistence completed.', 'STALE_SEMANTIC_SESSION')
      }
      await this.store.put(normalized)
      if (previous) this.forgetRun(previous.daemonSession)
      this.remember(normalized)
      return this.get(normalized.semanticSessionId)
    })
  }

  async delete(semanticSessionId: string, expectedCurrentRun?: AgentMuxRunRef): Promise<void> {
    await this.enqueue(semanticSessionId, async () => {
      const session = this.get(semanticSessionId)
      if (expectedCurrentRun && !sameRun(session.daemonSession, expectedCurrentRun)) {
        throw new AgentMuxError('Semantic session changed before deletion completed.', 'STALE_SEMANTIC_SESSION')
      }
      await this.store.delete(semanticSessionId)
      this.forgetRun(session.daemonSession)
      this.sessions.delete(semanticSessionId)
    })
  }

  findByRun(ref: AgentMuxRunRef): AgentMuxSemanticSession | undefined {
    const semanticSessionId = this.semanticIdByDaemonSession.get(ref.sessionId)
    const session = semanticSessionId ? this.sessions.get(semanticSessionId) : undefined
    return session && sameRun(session.daemonSession, ref) ? session : undefined
  }

  private reserve(semanticSessionId: string): () => void {
    this.reservations.add(semanticSessionId)
    return () => this.reservations.delete(semanticSessionId)
  }

  private async enqueue<T>(semanticSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(semanticSessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    const tail = current.then(() => {}, () => {})
    this.writeTails.set(semanticSessionId, tail)
    try {
      return await current
    } finally {
      if (this.writeTails.get(semanticSessionId) === tail) this.writeTails.delete(semanticSessionId)
    }
  }

  private remember(session: AgentMuxSemanticSession): void {
    const copy = structuredClone(session)
    this.sessions.set(copy.semanticSessionId, copy)
    this.semanticIdByDaemonSession.set(copy.daemonSession.sessionId, copy.semanticSessionId)
  }

  private forgetRun(ref: AgentMuxRunRef): void {
    const semanticSessionId = this.semanticIdByDaemonSession.get(ref.sessionId)
    const session = semanticSessionId ? this.sessions.get(semanticSessionId) : undefined
    if (session && sameRun(session.daemonSession, ref)) this.semanticIdByDaemonSession.delete(ref.sessionId)
  }
}
