import { AgentMuxError } from './errors.js'
import { randomUUID } from 'node:crypto'
import {
  loadAgentSessions,
  normalizeStoredAgentSession,
  type AgentMuxAgentSessionStore,
  type AgentMuxLifecycleReservation
} from './agent-session-store.js'
import type {
  AgentMuxRunRef,
  AgentMuxAgentSession,
  AgentMuxStoredAgentSession
} from './types.js'

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

type AgentSessionWrite = {
  started: boolean
  controller: AbortController
  run(): Promise<void>
  cancelQueued(): void
}

type AgentSessionWriteDrain = {
  promise: Promise<void>
  resolve(): void
}

export class AgentMuxAgentSessionRegistry {
  private readonly sessions = new Map<string, AgentMuxStoredAgentSession>()
  private readonly agentIdByRun = new Map<string, string>()
  private readonly agentIdByRetiredRun = new Map<string, string>()
  private readonly unboundRetiredRuns = new Set<string>()
  private readonly agentIdByNative = new Map<string, string>()
  private readonly writeQueues = new Map<string, AgentSessionWrite[]>()
  private readonly activeWrites = new Set<string>()
  private readonly writeDrains = new Map<string, AgentSessionWriteDrain>()
  private readonly lifecycleOwnerId = randomUUID()
  private static readonly lifecycleLeaseMs = 30_000

  constructor(private readonly store: AgentMuxAgentSessionStore) {}

  async load(hostId: string): Promise<void> {
    await Promise.allSettled([...this.writeDrains.values()].map((drain) => drain.promise))
    const [sessions, retiredRuns] = await Promise.all([
      loadAgentSessions(this.store),
      this.store.loadRetiredRuns()
    ])
    this.sessions.clear()
    this.agentIdByRun.clear()
    this.agentIdByRetiredRun.clear()
    this.unboundRetiredRuns.clear()
    this.agentIdByNative.clear()
    for (const session of sessions) {
      if (session.hostId === hostId) this.remember(session)
    }
    for (const run of retiredRuns) this.unboundRetiredRuns.add(run.runId)
  }

  list(): AgentMuxStoredAgentSession[] {
    return [...this.sessions.values()].map((session) => structuredClone(session))
  }

  has(agentSessionId: string): boolean {
    return this.sessions.has(agentSessionId)
  }

  get(agentSessionId: string): AgentMuxStoredAgentSession {
    const session = this.sessions.get(agentSessionId)
    if (!session) {
      throw new AgentMuxError(`Unknown Agent Session: ${agentSessionId}`, 'UNKNOWN_AGENT_SESSION')
    }
    return session
  }

  resolve(lookup: AgentMuxAgentSessionLookup): AgentMuxStoredAgentSession {
    if (lookup.kind === 'agent-session') return this.get(lookup.agentSessionId)
    const agentSessionId = lookup.kind === 'run'
      ? this.agentIdByRun.get(lookup.run.runId)
      : this.agentIdByNative.get(lookup.kind === 'provider-native'
          ? JSON.stringify(['provider', lookup.providerId, lookup.sessionId])
          : JSON.stringify(['acp', lookup.adapterId, lookup.sessionId]))
    const session = agentSessionId ? this.sessions.get(agentSessionId) : undefined
    if (
      !session &&
      lookup.kind === 'run' &&
      (this.agentIdByRetiredRun.has(lookup.run.runId) || this.unboundRetiredRuns.has(lookup.run.runId))
    ) {
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

  async reserveNew(
    agentSessionId: string,
    operationId: string
  ): Promise<AgentMuxLifecycleReservation> {
    return await this.reserveLifecycle({ kind: 'create', agentSessionId, operationId })
  }

  async reserveExisting(
    kind: 'resume' | 'stop',
    agentSessionId: string,
    operationId: string
  ): Promise<AgentMuxLifecycleReservation> {
    const session = this.get(agentSessionId)
    return await this.reserveLifecycle({
      kind,
      agentSessionId,
      operationId,
      expectedRun: session.run
    })
  }

  async claimStaleLifecycles(now = Date.now()): Promise<AgentMuxLifecycleReservation[]> {
    return await this.store.claimStaleLifecycles({
      ownerId: this.lifecycleOwnerId,
      ownerPid: process.pid,
      now,
      expiresAt: now + AgentMuxAgentSessionRegistry.lifecycleLeaseMs
    })
  }

  async releaseLifecycle(
    reservation: AgentMuxLifecycleReservation,
    retiredRuns: readonly AgentMuxRunRef[] = []
  ): Promise<void> {
    await this.store.releaseLifecycle(reservation, retiredRuns)
    for (const run of retiredRuns) this.unboundRetiredRuns.add(run.runId)
  }

  async retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void> {
    await this.store.retireRuns(runs)
    for (const run of runs) this.unboundRetiredRuns.add(run.runId)
  }

  async commitLifecycle(
    reservation: AgentMuxLifecycleReservation,
    session: AgentMuxStoredAgentSession | null
  ): Promise<AgentMuxStoredAgentSession | null> {
    const normalized = session ? normalizeStoredAgentSession(session) : null
    await this.store.commitLifecycle(reservation, normalized)
    const previous = this.sessions.get(reservation.agentSessionId)
    if (previous) this.forget(previous)
    if (!normalized) {
      this.sessions.delete(reservation.agentSessionId)
      return null
    }
    this.remember(normalized)
    return this.get(normalized.agentSessionId)
  }

  async put(
    session: AgentMuxStoredAgentSession,
    expectedCurrentRun?: AgentMuxRunRef
  ): Promise<AgentMuxStoredAgentSession> {
    const normalized = normalizeStoredAgentSession(session)
    return await this.enqueue(normalized.agentSessionId, async (signal) => {
      const previous = this.sessions.get(normalized.agentSessionId)
      if (expectedCurrentRun && (!previous || !sameRun(previous.run, expectedCurrentRun))) {
        throw new AgentMuxError('Agent Session changed before persistence completed.', 'STALE_AGENT_SESSION')
      }
      this.assertAvailable(normalized)
      await this.store.compareAndSwap(previous ?? null, normalized, signal)
      if (previous) this.forget(previous)
      this.remember(normalized)
      return this.get(normalized.agentSessionId)
    })
  }

  async update(
    agentSessionId: string,
    expectedCurrentRun: AgentMuxRunRef,
    operation: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession,
    signal?: AbortSignal
  ): Promise<AgentMuxStoredAgentSession> {
    return await this.enqueue(agentSessionId, async (writeSignal) => {
      writeSignal.throwIfAborted()
      const previous = this.get(agentSessionId)
      if (!sameRun(previous.run, expectedCurrentRun)) {
        throw new AgentMuxError(
          'Agent Session changed before persistence completed.',
          'STALE_AGENT_SESSION'
        )
      }
      const normalized = normalizeStoredAgentSession(operation(structuredClone(previous)))
      if (normalized.agentSessionId !== agentSessionId) {
        throw new AgentMuxError(
          'Agent Session update changed its identity.',
          'INVALID_AGENT_SESSION_STORE'
        )
      }
      this.assertAvailable(normalized)
      await this.store.compareAndSwap(previous, normalized, writeSignal)
      this.forget(previous)
      this.remember(normalized)
      return this.get(agentSessionId)
    }, signal)
  }

  async delete(agentSessionId: string, expectedCurrentRun?: AgentMuxRunRef): Promise<void> {
    await this.enqueue(agentSessionId, async (signal) => {
      const session = this.get(agentSessionId)
      if (expectedCurrentRun && !sameRun(session.run, expectedCurrentRun)) {
        throw new AgentMuxError('Agent Session changed before deletion completed.', 'STALE_AGENT_SESSION')
      }
      await this.store.compareAndSwap(session, null, signal)
      this.forget(session)
      this.sessions.delete(agentSessionId)
    })
  }

  findByRun(ref: AgentMuxRunRef): AgentMuxStoredAgentSession | undefined {
    const agentSessionId = this.agentIdByRun.get(ref.runId)
    const session = agentSessionId ? this.sessions.get(agentSessionId) : undefined
    return session && sameRun(session.run, ref) ? session : undefined
  }

  isRetiredRun(ref: AgentMuxRunRef): boolean {
    return this.agentIdByRetiredRun.has(ref.runId) || this.unboundRetiredRuns.has(ref.runId)
  }

  private async reserveLifecycle(input: {
    kind: AgentMuxLifecycleReservation['kind']
    agentSessionId: string
    operationId: string
    expectedRun?: AgentMuxRunRef
  }): Promise<AgentMuxLifecycleReservation> {
    const now = Date.now()
    const reservation: AgentMuxLifecycleReservation = {
      reservationId: randomUUID(),
      ownerId: this.lifecycleOwnerId,
      ownerPid: process.pid,
      kind: input.kind,
      agentSessionId: input.agentSessionId,
      operationId: input.operationId,
      expiresAt: now + AgentMuxAgentSessionRegistry.lifecycleLeaseMs,
      ...(input.expectedRun ? { expectedRun: { ...input.expectedRun } } : {})
    }
    await this.store.reserveLifecycle(reservation)
    return reservation
  }

  private async enqueue<T>(
    agentSessionId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      const cleanup = (): void => externalSignal?.removeEventListener('abort', abort)
      const entry: AgentSessionWrite = {
        started: false,
        controller,
        run: async () => {
          try {
            controller.signal.throwIfAborted()
            resolve(await operation(controller.signal))
          } catch (error) {
            reject(error)
          } finally {
            cleanup()
          }
        },
        cancelQueued: () => {
          const queue = this.writeQueues.get(agentSessionId)
          const index = queue?.indexOf(entry) ?? -1
          if (entry.started || index < 0 || !queue) return
          queue.splice(index, 1)
          cleanup()
          reject(controller.signal.reason)
          this.finishWriteQueueIfIdle(agentSessionId)
        }
      }
      const abort = (): void => {
        controller.abort(externalSignal?.reason)
        entry.cancelQueued()
      }
      const queue = this.writeQueues.get(agentSessionId) ?? []
      queue.push(entry)
      this.writeQueues.set(agentSessionId, queue)
      if (!this.writeDrains.has(agentSessionId)) {
        let finish!: () => void
        const promise = new Promise<void>((resolveDrain) => { finish = resolveDrain })
        this.writeDrains.set(agentSessionId, { promise, resolve: finish })
      }
      externalSignal?.addEventListener('abort', abort, { once: true })
      if (externalSignal?.aborted) abort()
      this.startNextWrite(agentSessionId)
    })
  }

  private startNextWrite(agentSessionId: string): void {
    if (this.activeWrites.has(agentSessionId)) return
    const queue = this.writeQueues.get(agentSessionId)
    const entry = queue?.shift()
    if (!entry) {
      this.finishWriteQueueIfIdle(agentSessionId)
      return
    }
    entry.started = true
    this.activeWrites.add(agentSessionId)
    void entry.run().finally(() => {
      this.activeWrites.delete(agentSessionId)
      this.startNextWrite(agentSessionId)
    })
  }

  private finishWriteQueueIfIdle(agentSessionId: string): void {
    if (this.activeWrites.has(agentSessionId)) return
    const queue = this.writeQueues.get(agentSessionId)
    if (queue && queue.length > 0) return
    this.writeQueues.delete(agentSessionId)
    const drain = this.writeDrains.get(agentSessionId)
    if (!drain) return
    this.writeDrains.delete(agentSessionId)
    drain.resolve()
  }

  private remember(session: AgentMuxStoredAgentSession): void {
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

  private assertAvailable(session: AgentMuxStoredAgentSession): void {
    if (
      this.unboundRetiredRuns.has(session.run.runId) ||
      session.retiredRuns.some((run) => this.unboundRetiredRuns.has(run.runId))
    ) {
      throw new AgentMuxError('Run is retired by an abandoned lifecycle.', 'AGENT_SESSION_IDENTITY_CONFLICT')
    }
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

  private forget(session: AgentMuxStoredAgentSession): void {
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
