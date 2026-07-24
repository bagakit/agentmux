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

function nativeKey(session: AgentMuxAgentSession): string | null {
  const handle = session.nativeHandle
  if (!handle) return null
  return handle.kind === 'provider'
    ? JSON.stringify(['provider', handle.providerId, handle.sessionId])
    : JSON.stringify(['acp', handle.adapterId, handle.sessionId])
}

export type AgentMuxAgentSessionLookup =
  | { kind: 'agent-session'; agentSessionId: string }
  | { kind: 'run'; run: AgentMuxRunRef }
  | { kind: 'provider-native'; providerId: string; sessionId: string }
  | { kind: 'acp-native'; adapterId: string; sessionId: string }

export class AgentMuxAgentSessionRegistry {
  private readonly sessions = new Map<string, AgentMuxAgentSession>()
  private readonly agentIdByRun = new Map<string, string>()
  private readonly agentIdByRetiredRun = new Map<string, string>()
  private readonly agentIdByNative = new Map<string, string>()
  private readonly reservations = new Set<string>()
  private readonly writeTails = new Map<string, Promise<void>>()

  constructor(private readonly store: AgentMuxAgentSessionStore) {}

  async load(hostId: string): Promise<void> {
    await Promise.allSettled(this.writeTails.values())
    const sessions = await loadAgentSessions(this.store)
    this.sessions.clear()
    this.agentIdByRun.clear()
    this.agentIdByRetiredRun.clear()
    this.agentIdByNative.clear()
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

  resolve(lookup: AgentMuxAgentSessionLookup): AgentMuxAgentSession {
    if (lookup.kind === 'agent-session') return this.get(lookup.agentSessionId)
    const agentSessionId = lookup.kind === 'run'
      ? this.agentIdByRun.get(lookup.run.runId)
      : this.agentIdByNative.get(lookup.kind === 'provider-native'
          ? JSON.stringify(['provider', lookup.providerId, lookup.sessionId])
          : JSON.stringify(['acp', lookup.adapterId, lookup.sessionId]))
    const session = agentSessionId ? this.sessions.get(agentSessionId) : undefined
    if (!session && lookup.kind === 'run' && this.agentIdByRetiredRun.has(lookup.run.runId)) {
      throw new AgentMuxError('Run binding is retired.', 'STALE_AGENT_SESSION_BINDING')
    }
    if (!session) {
      throw new AgentMuxError('Agent Session lookup did not match a current binding.', 'UNKNOWN_AGENT_SESSION_BINDING')
    }
    if (lookup.kind === 'run' && !sameRun(session.run, lookup.run)) {
      throw new AgentMuxError('Run binding is stale.', 'STALE_AGENT_SESSION_BINDING')
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
      this.assertAvailable(normalized)
      await this.store.put(normalized)
      if (previous) this.forget(previous)
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
      this.forget(session)
      this.sessions.delete(agentSessionId)
    })
  }

  findByRun(ref: AgentMuxRunRef): AgentMuxAgentSession | undefined {
    const agentSessionId = this.agentIdByRun.get(ref.runId)
    const session = agentSessionId ? this.sessions.get(agentSessionId) : undefined
    return session && sameRun(session.run, ref) ? session : undefined
  }

  isRetiredRun(ref: AgentMuxRunRef): boolean {
    return this.agentIdByRetiredRun.has(ref.runId)
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
    this.assertAvailable(session)
    const copy = structuredClone(session)
    this.sessions.set(copy.agentSessionId, copy)
    this.agentIdByRun.set(copy.run.runId, copy.agentSessionId)
    for (const retired of copy.retiredRuns) {
      this.agentIdByRetiredRun.set(retired.runId, copy.agentSessionId)
    }
    const key = nativeKey(copy)
    if (key) this.agentIdByNative.set(key, copy.agentSessionId)
  }

  private assertAvailable(session: AgentMuxAgentSession): void {
    const runOwner = this.agentIdByRun.get(session.run.runId)
    if (runOwner && runOwner !== session.agentSessionId) {
      throw new AgentMuxError('Run is already bound to another Agent Session.', 'AGENT_SESSION_IDENTITY_CONFLICT')
    }
    const retiredCurrentOwner = this.agentIdByRetiredRun.get(session.run.runId)
    if (retiredCurrentOwner && retiredCurrentOwner !== session.agentSessionId) {
      throw new AgentMuxError('Run is retired by another Agent Session.', 'AGENT_SESSION_IDENTITY_CONFLICT')
    }
    for (const retired of session.retiredRuns) {
      const currentOwner = this.agentIdByRun.get(retired.runId)
      const retiredOwner = this.agentIdByRetiredRun.get(retired.runId)
      if (
        (currentOwner && currentOwner !== session.agentSessionId) ||
        (retiredOwner && retiredOwner !== session.agentSessionId)
      ) {
        throw new AgentMuxError('Retired Run conflicts with another Agent Session.', 'AGENT_SESSION_IDENTITY_CONFLICT')
      }
    }
    const key = nativeKey(session)
    const nativeOwner = key ? this.agentIdByNative.get(key) : undefined
    if (nativeOwner && nativeOwner !== session.agentSessionId) {
      throw new AgentMuxError('Native handle is already bound to another Agent Session.', 'AGENT_SESSION_IDENTITY_CONFLICT')
    }
  }

  private forget(session: AgentMuxAgentSession): void {
    if (this.agentIdByRun.get(session.run.runId) === session.agentSessionId) {
      this.agentIdByRun.delete(session.run.runId)
    }
    for (const retired of session.retiredRuns) {
      if (this.agentIdByRetiredRun.get(retired.runId) === session.agentSessionId) {
        this.agentIdByRetiredRun.delete(retired.runId)
      }
    }
    const key = nativeKey(session)
    if (key && this.agentIdByNative.get(key) === session.agentSessionId) {
      this.agentIdByNative.delete(key)
    }
  }
}
