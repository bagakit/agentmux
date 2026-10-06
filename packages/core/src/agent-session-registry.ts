import { AgentMuxError } from './errors.js'
import { randomUUID } from 'node:crypto'
import { cloneSession } from './agent-session-identity.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import type { AgentCapabilityBinding } from './agent-capability.js'
import {
  loadAgentSessionMetadata,
  agentSessionMetadata,
  AgentMuxSessionDurabilityError,
  normalizeStoredAgentSession,
  type AgentMuxAgentSessionStore,
  type AgentMuxLifecycleReservation,
  type AgentMuxPreparedCreation,
  type AgentMuxRecoverableStopOperation,
  type AgentMuxRetiredAgentSession
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

type AgentSessionLoadCut = {
  sessions: Set<string>
  retirements: Set<string>
  runs: Set<string>
}

export class AgentMuxAgentSessionRegistry {
  private readonly sessions = new Map<string, AgentMuxStoredAgentSession>()
  private readonly providerIdByRun = new Map<string, string>()
  private readonly providerIdByRetiredRun = new Map<string, string>()
  private readonly unboundRetiredRuns = new Set<string>()
  private readonly retiredAgentSessions = new Map<string, AgentMuxRetiredAgentSession>()
  private readonly providerIdByNative = new Map<string, string>()
  private readonly writeQueues = new Map<string, AgentSessionWrite[]>()
  private readonly activeWrites = new Set<string>()
  private readonly writeDrains = new Map<string, AgentSessionWriteDrain>()
  private readonly metadataLoadCuts = new Set<AgentSessionLoadCut>()
  private readonly lifecycleOwnerId = randomUUID()
  private static readonly lifecycleLeaseMs = 30_000
  private readonly unconfirmedDurability = new Set<string>()

  constructor(private readonly store: AgentMuxAgentSessionStore,
    private readonly onDurabilityChange?: (session: AgentMuxStoredAgentSession, error: AgentMuxSessionDurabilityError | null) => void) {}

  isDurabilityUnconfirmed(agentSessionId: string): boolean {
    return this.unconfirmedDurability.has(agentSessionId)
  }

  async confirmDurability(agentSessionId: string, expectedRun: AgentMuxRunRef): Promise<AgentMuxStoredAgentSession> {
    return await this.enqueue(agentSessionId, async () => {
      const session = this.get(agentSessionId)
      if (!sameRun(session.run, expectedRun)) throw new AgentMuxError('Session changed before save confirmation.', 'STALE_AGENT_SESSION')
      await this.persist(session, () => this.store.confirmDurability(agentSessionId, expectedRun, session))
      return this.get(agentSessionId)
    })
  }

  /** A post-replacement receipt retains usable identity without claiming a durable acknowledgement. */
  private async persist(session: AgentMuxStoredAgentSession | null, write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (error) {
      if (session && error instanceof AgentMuxSessionDurabilityError) {
        const previous = this.sessions.get(session.agentSessionId)
        if (previous) this.forget(previous)
        this.remember(session)
        this.unconfirmedDurability.add(session.agentSessionId)
        this.notifyDurability(session, error)
      }
      throw error
    }
    if (session && this.unconfirmedDurability.delete(session.agentSessionId)) this.notifyDurability(session, null)
  }

  private notifyDurability(session: AgentMuxStoredAgentSession, error: AgentMuxSessionDurabilityError | null): void {
    try { this.onDurabilityChange?.(structuredClone(session), error) }
    catch { /* An observation consumer cannot change the completed filesystem operation. */ }
  }

  async load(hostId: string, assertCurrent?: () => void): Promise<void> {
    await Promise.allSettled([...this.writeDrains.values()].map((drain) => drain.promise))
    assertCurrent?.()
    // Record only changes during this read. Object equality cannot distinguish
    // an initially absent binding admitted and then removed before the reply.
    const cut: AgentSessionLoadCut = { sessions: new Set(), retirements: new Set(), runs: new Set() }
    this.metadataLoadCuts.add(cut)
    try {
      const [sessions, retiredRuns, retiredAgentSessions] = await Promise.all([
        loadAgentSessionMetadata(this.store),
        this.store.loadRetiredRuns(),
        this.store.loadRetiredAgentSessions()
      ])
      assertCurrent?.()
      const current = sessions.filter(session => session.hostId === hostId &&
        !cut.sessions.has(session.agentSessionId) && !this.unconfirmedDurability.has(session.agentSessionId))
      for (const session of this.sessions.values()) if (session.hostId === hostId &&
        (cut.sessions.has(session.agentSessionId) || this.unconfirmedDurability.has(session.agentSessionId))) current.push(session)
      const retired = retiredAgentSessions.filter(session => session.hostId === hostId && !cut.retirements.has(session.agentSessionId))
      for (const session of this.retiredAgentSessions.values()) if (session.hostId === hostId && cut.retirements.has(session.agentSessionId)) retired.push(session)
      const unbound = retiredRuns.filter(run => !cut.runs.has(run.runId))
      for (const runId of this.unboundRetiredRuns) if (cut.runs.has(runId)) unbound.push({ runId })
      // Publishing this cut also changes the same owner for other in-flight reads.
      for (const id of this.sessions.keys()) this.noteMetadataChange('sessions', id)
      for (const id of this.retiredAgentSessions.keys()) this.noteMetadataChange('retirements', id)
      for (const id of this.unboundRetiredRuns) this.noteMetadataChange('runs', id)
      this.sessions.clear()
      this.providerIdByRun.clear()
      this.providerIdByRetiredRun.clear()
      this.unboundRetiredRuns.clear()
      this.retiredAgentSessions.clear()
      this.providerIdByNative.clear()
      for (const session of current) this.remember(session)
      for (const run of unbound) {
        this.noteMetadataChange('runs', run.runId)
        this.unboundRetiredRuns.add(run.runId)
      }
      for (const session of retired) {
        this.noteMetadataChange('retirements', session.agentSessionId)
        this.retiredAgentSessions.set(session.agentSessionId, structuredClone(session))
      }
    } finally {
      this.metadataLoadCuts.delete(cut)
    }
  }

  private noteMetadataChange(kind: keyof AgentSessionLoadCut, id: string): void {
    for (const cut of this.metadataLoadCuts) cut[kind].add(id)
  }

  list(): AgentMuxStoredAgentSession[] {
    return [...this.sessions.values()].map((session) => structuredClone(session))
  }

  /** Existing metadata turns only; Native lifecycle waits do not enter this queue. */
  pendingMetadataIds(): readonly string[] { return [...this.writeQueues.keys()] }

  /** Take one exact read/publication cut before a later metadata turn may run. */
  async readMetadata(agentSessionId: string, consume: (session: AgentMuxStoredAgentSession | null) => void, signal?: AbortSignal): Promise<void> {
    await this.enqueue(agentSessionId, async readSignal => {
      const session = await this.store.readMetadata(agentSessionId)
      readSignal.throwIfAborted(); consume(session)
    }, signal)
  }

  /** Current public control facts, without cloning retained business bodies. */
  listPublic(): AgentMuxAgentSession[] {
    return [...this.sessions.values()].map(cloneSession)
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

  /** Adopt one exact durable binding only when this owner has not loaded it yet. */
  async resolveMetadata(agentSessionId: string, hostId: string, assertCurrent: () => void): Promise<AgentMuxStoredAgentSession> {
    const requireHost = (session: AgentMuxStoredAgentSession | null | undefined): AgentMuxStoredAgentSession => {
      if (!session || session.hostId !== hostId) throw new AgentMuxError('Agent Session is unknown on this Host.', 'UNKNOWN_AGENT_SESSION')
      return session
    }
    assertCurrent()
    if (this.sessions.has(agentSessionId)) return requireHost(this.sessions.get(agentSessionId))
    return await this.enqueue(agentSessionId, async () => {
      assertCurrent()
      // A predecessor on this same metadata queue may have published the binding.
      if (this.sessions.has(agentSessionId)) return requireHost(this.sessions.get(agentSessionId))
      const session = requireHost(await this.store.readMetadata(agentSessionId))
      assertCurrent()
      // A concurrent global read may already have admitted this exact subject.
      // This late read cannot replace that owner's published binding.
      if (this.sessions.has(agentSessionId)) return requireHost(this.sessions.get(agentSessionId))
      this.remember(session)
      return this.get(agentSessionId)
    })
  }

  resolve(lookup: AgentMuxAgentSessionLookup): AgentMuxStoredAgentSession {
    if (lookup.kind === 'agent-session') return this.get(resolveAgentSessionId(lookup.agentSessionId, [...this.sessions.keys(), ...this.retiredAgentSessions.keys()]))
    const agentSessionId = lookup.kind === 'run'
      ? this.providerIdByRun.get(lookup.run.runId)
      : this.providerIdByNative.get(lookup.kind === 'provider-native'
          ? JSON.stringify(['provider', lookup.providerId, lookup.sessionId])
          : JSON.stringify(['acp', lookup.adapterId, lookup.sessionId]))
    const session = agentSessionId ? this.sessions.get(agentSessionId) : undefined
    if (
      !session &&
      lookup.kind === 'run' &&
      (this.providerIdByRetiredRun.has(lookup.run.runId) || this.unboundRetiredRuns.has(lookup.run.runId))
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

  async reserveReopen(
    agentSessionId: string,
    expectedRetiredAt: number,
    operationId: string,
    callerOperationId: string
  ): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>> {
    const retirement = (await this.store.loadRetiredAgentSessions()).find(
      session => session.agentSessionId === agentSessionId
    )
    if (!retirement || retirement.observedAt !== expectedRetiredAt) {
      throw new AgentMuxError('Agent Session retirement changed before explicit continue.', 'STALE_AGENT_SESSION')
    }
    const reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> = {
      reservationId: randomUUID(), ownerId: this.lifecycleOwnerId, ownerPid: process.pid,
      agentSessionId, operationId, expiresAt: Date.now() + AgentMuxAgentSessionRegistry.lifecycleLeaseMs,
      kind: 'reopen', expectedRetirement: structuredClone(retirement), callerOperationId
    }
    await this.store.reserveLifecycle(reservation)
    return reservation
  }

  async reserveNew(
    agentSessionId: string,
    operationId: string
  ): Promise<AgentMuxLifecycleReservation> {
    return await this.reserveLifecycle({ kind: 'create', agentSessionId, operationId })
  }

  async reserveExisting(
    kind: 'resume',
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    operationId: string
  ): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>>
  async reserveExisting(
    kind: 'stop',
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    operationId: string,
    stopOperation: AgentMuxRecoverableStopOperation
  ): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'stop' }>>
  async reserveExisting(
    kind: 'resume' | 'stop',
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    operationId: string,
    stopOperation?: AgentMuxRecoverableStopOperation
  ): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'resume' | 'stop' }>> {
    const session = this.get(agentSessionId)
    if (!sameRun(session.run, expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before lifecycle reservation.',
        'STALE_AGENT_SESSION'
      )
    }
    const reservation = kind === 'resume'
      ? await this.reserveLifecycle({ kind, agentSessionId, operationId, expectedRun })
      : await this.reserveLifecycle({
          kind,
          agentSessionId,
          operationId,
          expectedRun,
          stopOperation: stopOperation!
        })
    if (reservation.kind === 'create' || reservation.kind === 'reopen') {
      throw new AgentMuxError('Existing lifecycle reservation changed kind.', 'INVALID_AGENT_SESSION_STORE')
    }
    return reservation
  }

  async prepareReopen(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, session: AgentMuxStoredAgentSession) {
    return await this.store.prepareReopen(reservation, session)
  }

  async prepareCreate(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'create' }>, seed: AgentMuxPreparedCreation) {
    return await this.store.prepareCreate(reservation, seed)
  }

  async claimCreate(agentSessionId: string, operationId: string, intentDigest: string) {
    return await this.store.claimCreate(agentSessionId, operationId, intentDigest, {
      ownerId: this.lifecycleOwnerId, ownerPid: process.pid, now: Date.now(),
      expiresAt: Date.now() + AgentMuxAgentSessionRegistry.lifecycleLeaseMs
    })
  }

  /** Actual started Run projection; its durable prepared seed remains until commit is confirmed. */
  rememberStartedCreation(value: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession {
    const session = normalizeStoredAgentSession(value), previous = this.sessions.get(session.agentSessionId)
    if (!session.creation?.intentDigest ||
      previous && !sameRun(previous.run, session.run)) throw new AgentMuxError('Unconfirmed creation does not match the retained real Run.', 'STALE_AGENT_SESSION')
    this.assertAvailable(session)
    if (previous) this.forget(previous)
    this.remember(session)
    return this.get(session.agentSessionId)
  }

  async releaseReopenOwner(): Promise<void> {
    await this.store.releaseReopenOwner(this.lifecycleOwnerId)
  }

  async claimReopen(agentSessionId: string, operationId: string, expectedRetiredAt: number) {
    return await this.store.claimReopen(agentSessionId, operationId, expectedRetiredAt, {
      ownerId: this.lifecycleOwnerId, ownerPid: process.pid, now: Date.now(),
      expiresAt: Date.now() + AgentMuxAgentSessionRegistry.lifecycleLeaseMs
    })
  }

  async claimStaleLifecycles(now = Date.now(), target?: { agentSessionId: string; expectedRun: AgentMuxRunRef }): Promise<AgentMuxLifecycleReservation[]> {
    const claimed = await this.store.claimStaleLifecycles({
      ownerId: this.lifecycleOwnerId,
      ownerPid: process.pid,
      now,
      expiresAt: now + AgentMuxAgentSessionRegistry.lifecycleLeaseMs
    }, target)
    if (target && (claimed.length > 1 || claimed.some(reservation => reservation.kind !== 'stop' ||
      reservation.agentSessionId !== target.agentSessionId || reservation.expectedRun.runId !== target.expectedRun.runId ||
      reservation.stopOperation.runId !== target.expectedRun.runId))) {
      throw new AgentMuxError('Agent Session Store returned another lifecycle for the exact Stop target.', 'INVALID_AGENT_SESSION_STORE')
    }
    return claimed
  }

  async releaseLifecycle(
    reservation: AgentMuxLifecycleReservation,
    retiredRuns: readonly AgentMuxRunRef[] = []
  ): Promise<void> {
    await this.store.releaseLifecycle(reservation, retiredRuns)
    for (const run of retiredRuns) {
      this.noteMetadataChange('runs', run.runId)
      this.unboundRetiredRuns.add(run.runId)
    }
  }

  async retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void> {
    await this.store.retireRuns(runs)
    for (const run of runs) {
      this.noteMetadataChange('runs', run.runId)
      this.unboundRetiredRuns.add(run.runId)
    }
  }

  async commitLifecycle(
    reservation: AgentMuxLifecycleReservation,
    session: AgentMuxStoredAgentSession | null
  ): Promise<AgentMuxStoredAgentSession | null> {
    const normalized = session ? normalizeStoredAgentSession(session) : null
    return await this.enqueue(reservation.agentSessionId, async () => {
      await this.persist(normalized, () => this.store.commitLifecycle(reservation, normalized))
      const previous = this.sessions.get(reservation.agentSessionId)
      if (previous) this.forget(previous)
      if (!normalized) {
        if (reservation.kind === 'stop' && previous) {
          for (const run of [...previous.retiredRuns, previous.run]) {
            this.noteMetadataChange('runs', run.runId)
            this.unboundRetiredRuns.add(run.runId)
          }
          const retired = (await this.store.loadRetiredAgentSessions()).find(
            (session) => session.agentSessionId === reservation.agentSessionId
          )
          if (!retired) {
            throw new AgentMuxError(
              'Stop lifecycle did not persist Agent Session retirement.',
              'INVALID_AGENT_SESSION_STORE'
            )
          }
          this.noteMetadataChange('retirements', retired.agentSessionId)
          this.retiredAgentSessions.set(retired.agentSessionId, structuredClone(retired))
        }
        this.noteMetadataChange('sessions', reservation.agentSessionId)
        this.sessions.delete(reservation.agentSessionId)
        return null
      }
      if (reservation.kind === 'reopen') {
        this.noteMetadataChange('retirements', normalized.agentSessionId)
        this.retiredAgentSessions.delete(normalized.agentSessionId)
        this.noteMetadataChange('runs', reservation.expectedRetirement.run.runId)
        this.unboundRetiredRuns.delete(reservation.expectedRetirement.run.runId)
      }
      this.remember(normalized)
      return this.get(normalized.agentSessionId)
    })
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
      await this.persist(normalized, () => previous ? this.store.compareAndSwapMetadata(previous, agentSessionMetadata(normalized), signal) : this.store.compareAndSwap(null, normalized, signal))
      if (previous) this.forget(previous)
      this.remember(normalized)
      return this.get(normalized.agentSessionId)
    })
  }

  async update(
    agentSessionId: string,
    expectedCurrentRun: AgentMuxRunRef,
    operation: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession,
    signal?: AbortSignal,
    futureIntentId?: string,
    author?: Readonly<AgentCapabilityBinding>
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
      const future = futureIntentId === undefined ? undefined : await this.store.readFuturePromptIntent(agentSessionId, futureIntentId)
      const current = { ...previous, ...(futureIntentId === undefined || !future ? {} : { futurePromptIntents: { [futureIntentId]: future } }) }
      const normalized = normalizeStoredAgentSession(operation(structuredClone(current)))
      if (normalized.futurePromptIntents && (futureIntentId === undefined || Object.keys(normalized.futurePromptIntents).some(id => id !== futureIntentId))) {
        throw new AgentMuxError('A future-message update must name its exact intent.', 'INVALID_AGENT_SESSION_STORE')
      }
      if (normalized.agentSessionId !== agentSessionId) {
        throw new AgentMuxError(
          'Agent Session update changed its identity.',
          'INVALID_AGENT_SESSION_STORE'
        )
      }
      this.assertAvailable(normalized)
      await this.persist(agentSessionMetadata(normalized), () => this.store.compareAndSwapMetadata(previous, agentSessionMetadata(normalized), writeSignal,
        futureIntentId === undefined ? undefined : { intentId: futureIntentId, expected: future ?? null, next: normalized.futurePromptIntents?.[futureIntentId] ?? null }, author))
      this.forget(previous)
      this.remember(normalized)
      return futureIntentId === undefined ? this.get(agentSessionId) : normalized
    }, signal)
  }

  /** Refresh one binding without replacing unrelated Sessions or writing an unchanged record. */
  async refresh(agentSessionId: string, expectedRun: AgentMuxRunRef, futureIntentId?: string): Promise<AgentMuxStoredAgentSession> {
    return await this.enqueue(agentSessionId, async () => {
      const previous = this.get(agentSessionId)
      const current = await this.store.readMetadata(agentSessionId)
      if (!current) {
        throw new AgentMuxError(
          'The current Session record could not be confirmed. Its Run is kept; refresh the Store before retrying this prompt.',
          'AGENT_SESSION_STORE_READ_UNCONFIRMED'
        )
      }
      if (current.hostId !== previous.hostId) {
        throw new AgentMuxError('Agent Session Host changed before prompt Input.', 'STALE_AGENT_SESSION')
      }
      this.assertAvailable(current)
      this.forget(previous)
      this.remember(current)
      if (!sameRun(current.run, expectedRun)) {
        throw new AgentMuxError('Agent Session changed before prompt Input.', 'STALE_AGENT_SESSION')
      }
      if (futureIntentId === undefined) return this.get(agentSessionId)
      const future = await this.store.readFuturePromptIntent(agentSessionId, futureIntentId)
      return { ...current, ...(future ? { futurePromptIntents: { [futureIntentId]: future } } : {}) }
    })
  }

  async delete(agentSessionId: string, expectedCurrentRun?: AgentMuxRunRef): Promise<void> {
    await this.enqueue(agentSessionId, async (signal) => {
      const session = this.get(agentSessionId)
      if (expectedCurrentRun && !sameRun(session.run, expectedCurrentRun)) {
        throw new AgentMuxError('Agent Session changed before deletion completed.', 'STALE_AGENT_SESSION')
      }
      await this.store.compareAndSwapMetadata(session, null, signal)
      this.forget(session)
      this.sessions.delete(agentSessionId)
    })
  }

  findByRun(ref: AgentMuxRunRef): AgentMuxStoredAgentSession | undefined {
    const agentSessionId = this.providerIdByRun.get(ref.runId)
    const session = agentSessionId ? this.sessions.get(agentSessionId) : undefined
    return session && sameRun(session.run, ref) ? session : undefined
  }

  isRetiredRun(ref: AgentMuxRunRef): boolean {
    return this.providerIdByRetiredRun.has(ref.runId) || this.unboundRetiredRuns.has(ref.runId)
  }

  retiredAgentSession(
    agentSessionId: string,
    ref: AgentMuxRunRef
  ): AgentMuxRetiredAgentSession | undefined {
    const retired = this.retiredAgentSessions.get(agentSessionId)
    return retired?.run.runId === ref.runId ? structuredClone(retired) : undefined
  }

  private async reserveLifecycle(input: (
    | {
        kind: 'create'
        agentSessionId: string
        operationId: string
      }
    | {
        kind: 'resume'
        agentSessionId: string
        operationId: string
        expectedRun: AgentMuxRunRef
      }
    | {
        kind: 'stop'
        agentSessionId: string
        operationId: string
        expectedRun: AgentMuxRunRef
        stopOperation: AgentMuxRecoverableStopOperation
      }
  )): Promise<AgentMuxLifecycleReservation> {
    const now = Date.now()
    const base = {
      reservationId: randomUUID(),
      ownerId: this.lifecycleOwnerId,
      ownerPid: process.pid,
      agentSessionId: input.agentSessionId,
      operationId: input.operationId,
      expiresAt: now + AgentMuxAgentSessionRegistry.lifecycleLeaseMs
    }
    const reservation: AgentMuxLifecycleReservation = input.kind === 'create'
      ? { ...base, kind: 'create' }
      : input.kind === 'resume'
        ? { ...base, kind: 'resume', expectedRun: { ...input.expectedRun } }
        : {
            ...base,
            kind: 'stop',
            expectedRun: { ...input.expectedRun },
            stopOperation: { ...input.stopOperation }
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
    const copy = structuredClone(agentSessionMetadata(session))
    this.noteMetadataChange('sessions', copy.agentSessionId)
    this.sessions.set(copy.agentSessionId, copy)
    this.providerIdByRun.set(copy.run.runId, copy.agentSessionId)
    for (const retired of copy.retiredRuns) {
      this.providerIdByRetiredRun.set(retired.runId, copy.agentSessionId)
    }
    const key = nativeKey(copy)
    if (key) this.providerIdByNative.set(key, copy.agentSessionId)
  }

  private assertAvailable(session: AgentMuxStoredAgentSession): void {
    if (
      this.unboundRetiredRuns.has(session.run.runId) ||
      session.retiredRuns.some((run) => this.unboundRetiredRuns.has(run.runId))
    ) {
      throw new AgentMuxError('Run is retired by an abandoned lifecycle.', 'AGENT_SESSION_IDENTITY_CONFLICT')
    }
    const runOwner = this.providerIdByRun.get(session.run.runId)
    if (runOwner && runOwner !== session.agentSessionId) {
      throw new AgentMuxError('Run is already bound to another Agent Session.', 'AGENT_SESSION_IDENTITY_CONFLICT')
    }
    const retiredCurrentOwner = this.providerIdByRetiredRun.get(session.run.runId)
    if (retiredCurrentOwner && retiredCurrentOwner !== session.agentSessionId) {
      throw new AgentMuxError('Run is retired by another Agent Session.', 'AGENT_SESSION_IDENTITY_CONFLICT')
    }
    for (const retired of session.retiredRuns) {
      const currentOwner = this.providerIdByRun.get(retired.runId)
      const retiredOwner = this.providerIdByRetiredRun.get(retired.runId)
      if (
        (currentOwner && currentOwner !== session.agentSessionId) ||
        (retiredOwner && retiredOwner !== session.agentSessionId)
      ) {
        throw new AgentMuxError('Retired Run conflicts with another Agent Session.', 'AGENT_SESSION_IDENTITY_CONFLICT')
      }
    }
    const key = nativeKey(session)
    const nativeOwner = key ? this.providerIdByNative.get(key) : undefined
    if (nativeOwner && nativeOwner !== session.agentSessionId) {
      throw new AgentMuxError('Native handle is already bound to another Agent Session.', 'AGENT_SESSION_IDENTITY_CONFLICT')
    }
  }

  private forget(session: AgentMuxStoredAgentSession): void {
    this.noteMetadataChange('sessions', session.agentSessionId)
    if (this.providerIdByRun.get(session.run.runId) === session.agentSessionId) {
      this.providerIdByRun.delete(session.run.runId)
    }
    for (const retired of session.retiredRuns) {
      if (this.providerIdByRetiredRun.get(retired.runId) === session.agentSessionId) {
        this.providerIdByRetiredRun.delete(retired.runId)
      }
    }
    const key = nativeKey(session)
    if (key && this.providerIdByNative.get(key) === session.agentSessionId) {
      this.providerIdByNative.delete(key)
    }
  }
}
