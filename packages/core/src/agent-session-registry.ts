import { AgentMuxError } from './errors.js'
import {
  loadAgentSessions,
  normalizeStoredAgentSession,
  type AgentMuxAgentSessionStore
} from './agent-session-store.js'
import type { AgentMuxRunRef, AgentMuxAgentSession } from './types.js'

function sameRun(left: AgentMuxRunRef, right: AgentMuxRunRef): boolean {
  return left.runId === right.runId
}

export class AgentMuxAgentSessionRegistry {
  private readonly sessions = new Map<string, AgentMuxAgentSession>()
  private readonly agentIdByRun = new Map<string, string>()
  private readonly reservations = new Set<string>()
  private readonly writeTails = new Map<string, Promise<void>>()

  constructor(private readonly store: AgentMuxAgentSessionStore) {}

  async load(hostId: string): Promise<void> {
    await Promise.allSettled(this.writeTails.values())
    const sessions = await loadAgentSessions(this.store)
    this.sessions.clear()
    this.agentIdByRun.clear()
    for (const session of sessions) {
      if (session.hostId === hostId) this.remember(session)
    }
  }

  list(): AgentMuxAgentSession[] {
    return [...this.sessions.values()].map((session) => structuredClone(session))
  }

  has(agentSessionId: string): boolean {
    return this.sessions.has(agentSessionId)
  }

  get(agentSessionId: string): AgentMuxAgentSession {
    const session = this.sessions.get(agentSessionId)
    if (!session) {
      throw new AgentMuxError(`Unknown Agent Session: ${agentSessionId}`, 'UNKNOWN_AGENT_SESSION')
    }
    return session
  }

  reserveNew(agentSessionId: string): () => void {
    if (this.sessions.has(agentSessionId) || this.reservations.has(agentSessionId)) {
      throw new AgentMuxError(`Agent Session already exists: ${agentSessionId}`, 'DUPLICATE_AGENT_SESSION')
    }
    return this.reserve(agentSessionId)
  }

  reserveExisting(agentSessionId: string): () => void {
    this.get(agentSessionId)
    if (this.reservations.has(agentSessionId)) {
      throw new AgentMuxError('Agent Session already has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    }
    return this.reserve(agentSessionId)
  }

  async put(
    session: AgentMuxAgentSession,
    expectedCurrentRun?: AgentMuxRunRef
  ): Promise<AgentMuxAgentSession> {
    const normalized = normalizeStoredAgentSession(session)
    return await this.enqueue(normalized.agentSessionId, async () => {
      const previous = this.sessions.get(normalized.agentSessionId)
      if (expectedCurrentRun && (!previous || !sameRun(previous.run, expectedCurrentRun))) {
        throw new AgentMuxError('Agent Session changed before persistence completed.', 'STALE_AGENT_SESSION')
      }
      await this.store.put(normalized)
      if (previous) this.forgetRun(previous.run)
      this.remember(normalized)
      return this.get(normalized.agentSessionId)
    })
  }

  async delete(agentSessionId: string, expectedCurrentRun?: AgentMuxRunRef): Promise<void> {
    await this.enqueue(agentSessionId, async () => {
      const session = this.get(agentSessionId)
      if (expectedCurrentRun && !sameRun(session.run, expectedCurrentRun)) {
        throw new AgentMuxError('Agent Session changed before deletion completed.', 'STALE_AGENT_SESSION')
      }
      await this.store.delete(agentSessionId)
      this.forgetRun(session.run)
      this.sessions.delete(agentSessionId)
    })
  }

  findByRun(ref: AgentMuxRunRef): AgentMuxAgentSession | undefined {
    const agentSessionId = this.agentIdByRun.get(ref.runId)
    const session = agentSessionId ? this.sessions.get(agentSessionId) : undefined
    return session && sameRun(session.run, ref) ? session : undefined
  }

  private reserve(agentSessionId: string): () => void {
    this.reservations.add(agentSessionId)
    return () => this.reservations.delete(agentSessionId)
  }

  private async enqueue<T>(agentSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(agentSessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    const tail = current.then(() => {}, () => {})
    this.writeTails.set(agentSessionId, tail)
    try {
      return await current
    } finally {
      if (this.writeTails.get(agentSessionId) === tail) this.writeTails.delete(agentSessionId)
    }
  }

  private remember(session: AgentMuxAgentSession): void {
    const copy = structuredClone(session)
    this.sessions.set(copy.agentSessionId, copy)
    this.agentIdByRun.set(copy.run.runId, copy.agentSessionId)
  }

  private forgetRun(ref: AgentMuxRunRef): void {
    const agentSessionId = this.agentIdByRun.get(ref.runId)
    const session = agentSessionId ? this.sessions.get(agentSessionId) : undefined
    if (session && sameRun(session.run, ref)) this.agentIdByRun.delete(ref.runId)
  }
}
