import { AgentMuxError, AGENTMUX_AGENT_MESSAGING_GUIDANCE, ContinuousProgressScheduler, agentPromptCondition, decideContinuousProgress, decideFutureProgress, type ContinuousProgressLoop, type ContinuousProgressTarget, type ContinuousProgressObservation, type ContinuousProgressTaskSource } from '@agentmux/core'
import { parseScheduleRpcParams, type ScheduleMethod, type ScheduleParamsMap, type ScheduleResultMap, type AgentMuxRpcCallContext } from '@agentmux/core'
import { nextCalendarOccurrence, latestCalendarOccurrence } from './agent-schedule-calendar.js'
import { readContinuousProgressTaskSource, validateContinuousProgressTaskSource } from './continuous-progress-task-source.js'
import type { ContinuousProgressLoopStore } from './continuous-progress-loop-store.js'
import { AGENT_SCHEDULE_CHECK_IN_GUIDANCE } from '@agentmux/core/schedule'
import { decideCheckIn, type CheckInObservation } from './agent-schedule-check-in.js'

export type LoopTickOutcome = 'sent' | 'skipped' | 'unknown'
export type LoopTickHandler = (loop: ContinuousProgressLoop, operationId: string, isCurrent: () => boolean, signal: AbortSignal) => Promise<LoopTickOutcome>
export type LoopObservationProvider = (loop: ContinuousProgressLoop, tickId: string, now: number, signal: AbortSignal) => Promise<ContinuousProgressObservation>
export type FutureProgressInputOwner = {
  saveFutureIntent(loop: ContinuousProgressLoop, active: boolean, context?: AgentMuxRpcCallContext): Promise<void>
  authorizeFutureIntent?(target: ContinuousProgressTarget, context?: AgentMuxRpcCallContext): Promise<void>
  observeCheckIn?(target: ContinuousProgressTarget, now: number, signal: AbortSignal): Promise<CheckInObservation>
}

/** Main-process owner: scheduler and durable store stay together; renderer only observes results. */
export class ContinuousProgressLoopManager {
  private readonly scheduler: ContinuousProgressScheduler
  private timer: ReturnType<typeof setInterval> | null = null
  private checkPromise: Promise<void> | null = null
  private running = false
  private started: Promise<void> | undefined
  private readonly listeners = new Set<(loop: ContinuousProgressLoop) => void>()
  private activeDelivery: { loopId: string; controller: AbortController } | undefined
  private readonly mutations = new Map<string, Promise<unknown>>()
  constructor(private readonly store: ContinuousProgressLoopStore, private readonly onTick: LoopTickHandler, private readonly now: (() => number) = Date.now, private readonly observe: LoopObservationProvider, private readonly futureInputs?: FutureProgressInputOwner) {
    this.scheduler = new ContinuousProgressScheduler({ now })
  }
  start(): Promise<void> { return this.started ??= this.startOnce() }
  private async startOnce(): Promise<void> {
    this.scheduler.restore((await this.store.load()).map((loop) => loop.pendingCompletion && loop.status === 'active'
      ? { ...loop, status: 'paused', lastOutcome: 'unknown' } : loop))
    await this.store.save(this.scheduler.list())
    this.running = true
    if (!this.timer) this.timer = setInterval(() => { void this.check().catch(() => {}) }, 1000)
  }
  async stop(): Promise<void> {
    if (!this.started) return
    try { await this.started } catch { return }
    this.running = false
    this.activeDelivery?.controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.checkPromise?.catch(() => {})
    await this.store.save(this.scheduler.list())
  }
  list(): ContinuousProgressLoop[] { return this.scheduler.list() }
  async call<M extends ScheduleMethod>(method: M, input: ScheduleParamsMap[M], context?: AgentMuxRpcCallContext): Promise<ScheduleResultMap[M]> {
    const params = parseScheduleRpcParams(method, input)
    if (method === 'schedule.create' && (params as ScheduleParamsMap['schedule.create']).checkIn &&
        (context?.caller || !context?.principal || !['user','device'].includes(context.principal.kind))) throw new AgentMuxError('Quiet follow-up requires explicit opt-in from the authenticated user or device. Existing arrangements and manual input remain available.', 'SCHEDULE_CHECK_IN_OPT_IN_REQUIRED')
    if (method === 'schedule.list' || method === 'schedule.inspect') return this.callOwned(method, params, context)
    const create = params as ScheduleParamsMap['schedule.create']
    const key = method === 'schedule.create' ? create.checkIn ? 'checkin:' + JSON.stringify([create.target.hostId, create.target.agentSessionId, create.target.providerId, create.target.workspacePath]) : `create:${create.operationId}` : (params as ScheduleParamsMap['schedule.pause']).scheduleId
    const previous = this.mutations.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.callOwned(method, params, context))
    this.mutations.set(key, operation)
    try { return await operation } finally { if (this.mutations.get(key) === operation) this.mutations.delete(key) }
  }
  private async callOwned<M extends ScheduleMethod>(method: M, input: ScheduleParamsMap[M], context?: AgentMuxRpcCallContext): Promise<ScheduleResultMap[M]> {
    const params = parseScheduleRpcParams(method, input)
    await this.start()
    const scope = { executionScope: 'connected-host' as const }
    if (method === 'schedule.list') {
      const { target } = params as ScheduleParamsMap['schedule.list']
      return { ...scope, schedules: this.list().filter(loop => loop.calendar && (!target || ['hostId','agentSessionId','providerId','workspacePath'].every(key => loop[key as keyof ContinuousProgressTarget] === target[key as keyof ContinuousProgressTarget]))) } as ScheduleResultMap[M]
    }
    if (method === 'schedule.inspect') {
      const p = params as ScheduleParamsMap['schedule.inspect']
      return { ...scope, schedule: this.list().find(loop => loop.calendar && (p.scheduleId ? loop.loopId === p.scheduleId : loop.creationOperationId === p.operationId || loop.lastMutation?.operationId === p.operationId || loop.pendingCompletion?.operationId === p.operationId || loop.lastTickId === p.operationId)) ?? null } as ScheduleResultMap[M]
    }
    if (method === 'schedule.create') {
      const p = params as ScheduleParamsMap['schedule.create']
      if (p.checkIn && (context?.caller || !context?.principal || !['user','device'].includes(context.principal.kind))) throw new AgentMuxError('Quiet follow-up requires explicit opt-in from the authenticated user or device. Existing arrangements and manual input remain available.', 'SCHEDULE_CHECK_IN_OPT_IN_REQUIRED')
      await this.authorizeCaller(p.target, context)
      const existing = this.list().find(loop => loop.creationOperationId === p.operationId)
      if (existing) {
        if (existing.prompt !== p.prompt || JSON.stringify(existing.calendar) !== JSON.stringify(p.calendar) || JSON.stringify(existing.checkIn) !== JSON.stringify(p.checkIn) || ['hostId','agentSessionId','providerId','workspacePath'].some(key => existing[key as keyof ContinuousProgressTarget] !== p.target[key as keyof ContinuousProgressTarget])) throw new AgentMuxError('Schedule operation was reused with conflicting target or content.', 'SCHEDULE_OPERATION_CONFLICT')
        if (!this.futureInputs) throw new AgentMuxError('Future-message admission durability is unconfirmed.', 'SCHEDULE_INPUT_OWNER_UNAVAILABLE')
        const retryCreation = existing.status === 'paused' && existing.lastOutcome === 'unknown' && !existing.lastTickId && !existing.lastMutation
        await this.futureInputs.saveFutureIntent(existing, retryCreation || existing.status === 'active', context)
        if (retryCreation) {
          const { lastOutcome: _, lastDecision: __, ...confirmed } = this.require(existing.loopId)
          this.scheduler.restore(this.list().map(loop => loop.loopId === existing.loopId ? { ...confirmed, status: 'active' } : loop))
        }
        await this.persist(existing.loopId)
        return { ...scope, schedule: this.require(existing.loopId), diskDurability: 'confirmed' } as ScheduleResultMap[M]
      }
      if (!this.futureInputs) throw new AgentMuxError('The connected Host cannot save future-message admission. The Agent and manual input remain available.', 'SCHEDULE_INPUT_OWNER_UNAVAILABLE')
      if (p.checkIn && this.list().some(loop => loop.checkIn && loop.status !== 'stopped' && ['hostId','agentSessionId','providerId','workspacePath'].every(key => loop[key as keyof ContinuousProgressTarget] === p.target[key as keyof ContinuousProgressTarget]))) throw new AgentMuxError('This Agent already has a saved quiet follow-up. Inspect, pause or cancel that original arrangement.', 'SCHEDULE_CHECK_IN_EXISTS')
      const nextDue = nextCalendarOccurrence(p.calendar, this.now())
      if (nextDue === null) throw new AgentMuxError('This one-time civil occurrence is past or falls in a skipped DST gap. Choose a valid future time.', 'SCHEDULE_NO_FUTURE_OCCURRENCE')
      const loop = this.scheduler.createCalendar({ ...p.target, prompt: p.prompt, calendar: p.calendar, nextDue, operationId: p.operationId, ...(p.checkIn ? { checkIn: p.checkIn } : {}) })
      this.patch(loop.loopId, { status: 'paused' })
      try { await this.persist(loop.loopId); await this.futureInputs.saveFutureIntent(loop, true, context); this.patch(loop.loopId, { status: 'active' }); await this.persist(loop.loopId) }
      catch (error) { this.patch(loop.loopId, { status: 'paused', lastOutcome: 'unknown', lastDecision: 'Saving the future-message intent is unconfirmed. Inspect the original operation; manual input remains available.' }); await this.persist(loop.loopId); throw error }
      return { ...scope, schedule: this.require(loop.loopId), diskDurability: 'confirmed' } as ScheduleResultMap[M]
    }
    const p = params as ScheduleParamsMap['schedule.pause'], action = method.slice('schedule.'.length) as 'pause' | 'resume' | 'cancel'
    const loop = this.require(p.scheduleId)
    if (!loop.calendar) throw new AgentMuxError('This public operation requires a calendar arrangement.', 'UNKNOWN_SCHEDULE')
    await this.authorizeCaller(loop, context)
    if (loop.lastMutation?.operationId === p.operationId) {
      if (loop.lastMutation.action !== action || loop.lastMutation.expectedRevision !== p.expectedRevision) throw new AgentMuxError('Schedule mutation operation conflicts with the original action.', 'SCHEDULE_OPERATION_CONFLICT')
    } else {
      if (loop.revision !== p.expectedRevision) throw new AgentMuxError('Schedule revision changed. Inspect the original arrangement before editing.', 'SCHEDULE_REVISION_CONFLICT')
      if (action === 'resume' && loop.status === 'stopped') throw new AgentMuxError('A cancelled arrangement cannot resume. Save a new arrangement explicitly.', 'SCHEDULE_CANCELLED')
      this.patch(loop.loopId, { revision: p.expectedRevision + 1, lastMutation: { operationId: p.operationId, action, expectedRevision: p.expectedRevision } })
    }
    if (action === 'resume') await this.resume(loop.loopId, context)
    else if (action === 'pause') await this.pause(loop.loopId, 'Paused by you.', context)
    else await this.stopLoop(loop.loopId, context)
    await this.persist(loop.loopId)
    return { ...scope, schedule: this.require(loop.loopId), diskDurability: 'confirmed' } as ScheduleResultMap[M]
  }
  subscribe(listener: (loop: ContinuousProgressLoop) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private async authorizeCaller(target: ContinuousProgressTarget, context?: AgentMuxRpcCallContext): Promise<void> {
    if (!context?.caller) return
    if (!this.futureInputs?.authorizeFutureIntent) throw new AgentMuxError('The original target authorization owner is unavailable; the arrangement and manual Agent input are retained.', 'SCHEDULE_INPUT_OWNER_UNAVAILABLE')
    await this.futureInputs.authorizeFutureIntent(target, context)
  }
  async create(input: ContinuousProgressTarget & { intervalMs: number; prompt: string; taskSource?: ContinuousProgressTaskSource }): Promise<ContinuousProgressLoop> {
    await this.start()
    if (input.taskSource !== undefined) validateContinuousProgressTaskSource(input.taskSource)
    const loop = this.scheduler.create(input)
    await this.persist(loop.loopId)
    return loop
  }
  async pause(loopId: string, reason = 'Paused by you.', context?: AgentMuxRpcCallContext): Promise<ContinuousProgressLoop> {
    await this.start()
    this.scheduler.pause(loopId); this.patch(loopId, { lastDecision: reason }); this.cancelDelivery(loopId)
    await this.persist(loopId)
    if (this.require(loopId).calendar) await this.futureInputs?.saveFutureIntent(this.require(loopId), false, context)
    return this.require(loopId)
  }
  async resume(loopId: string, context?: AgentMuxRpcCallContext): Promise<ContinuousProgressLoop> {
    await this.start()
    const before = this.require(loopId)
    if (before.calendar) await this.futureInputs?.saveFutureIntent(before, true, context)
    if (this.require(loopId).status === 'stopped' || this.require(loopId).revision !== before.revision) return this.require(loopId)
    const { lastDecision: _, ...loop } = this.scheduler.resume(loopId)
    this.scheduler.restore(this.list().map(value => value.loopId === loopId ? loop : value))
    await this.persist(loopId)
    return loop
  }
  async stopLoop(loopId: string, context?: AgentMuxRpcCallContext): Promise<ContinuousProgressLoop> {
    await this.start()
    this.scheduler.stop(loopId); this.cancelDelivery(loopId)
    await this.persist(loopId)
    if (this.require(loopId).calendar) await this.futureInputs?.saveFutureIntent(this.require(loopId), false, context)
    return this.require(loopId)
  }
  async checkNow(loopId: string): Promise<ContinuousProgressLoop> {
    await this.start()
    if (this.require(loopId).status !== 'active') throw new Error('Resume this loop before checking it.')
    if (!this.require(loopId).calendar) this.scheduler.requestCheck(loopId)
    await this.checkPromise
    await this.check()
    return this.require(loopId)
  }
  pauseTarget(target: Pick<ContinuousProgressTarget, 'hostId' | 'agentSessionId'>, reason: string): Promise<void> {
    const changed = this.list().filter(loop => !loop.calendar && loop.hostId === target.hostId && loop.agentSessionId === target.agentSessionId && loop.status === 'active')
    for (const loop of changed) {
      this.scheduler.pause(loop.loopId); this.patch(loop.loopId, { lastDecision: reason }); this.cancelDelivery(loop.loopId)
    }
    // Cancellation is synchronous. Human input does not wait for a durable loop write.
    return Promise.all(changed.map(loop => this.persist(loop.loopId))).then(() => {})
  }
  private require(loopId: string): ContinuousProgressLoop {
    const loop = this.list().find(loop => loop.loopId === loopId)
    if (!loop) throw new Error('Continuous progress loop is unavailable.')
    return loop
  }
  private async persist(loopId: string): Promise<void> {
    try { await this.store.save(this.scheduler.list()) }
    catch (error) {
      this.patch(loopId, { status: 'paused', lastDecision: `Loop persistence is unconfirmed. Manual input remains available. ${error instanceof Error ? error.message : String(error)}` })
      for (const listener of this.listeners) listener(this.require(loopId))
      throw error
    }
    for (const listener of this.listeners) listener(this.require(loopId))
  }
  async check(now?: number): Promise<void> {
    if (this.checkPromise) return await this.checkPromise
    this.checkPromise = this.checkOnce(now).finally(() => { this.checkPromise = null })
    return await this.checkPromise
  }
  private async checkOnce(now?: number): Promise<void> {
    if (!this.running) return
    const checkAt = now ?? this.now()
    for (const loop of this.scheduler.due(checkAt)) {
      if (loop.calendar && !loop.pendingCompletion) {
        const latest = latestCalendarOccurrence(loop.calendar, loop.nextCheckAt, checkAt)
        if (latest !== loop.nextCheckAt) this.patch(loop.loopId, { nextCheckAt: latest, lastDecision: 'Missed older occurrences; only the latest due occurrence is eligible.' })
      }
    }
    const claims = this.scheduler.recover(now)
    if (claims.length === 0) return
    // Claim and persist before invoking provider code. A crash or unknown callback result cannot replay a tick.
    try { await this.store.save(this.scheduler.list()) }
    catch (error) {
      for (const claim of claims) {
        this.patch(claim.loop.loopId, { status: 'paused', lastDecision: `Automatic claim persistence is unconfirmed. Manual input remains available. ${error instanceof Error ? error.message : String(error)}` })
        for (const listener of this.listeners) listener(this.require(claim.loop.loopId))
      }
      throw error
    }
    for (const claim of claims) {
      const isCurrent = () => this.running && this.scheduler.list().some((loop) =>
        loop.loopId === claim.loop.loopId && loop.status === 'active' && loop.lastTickId === claim.tickId)
      const controller = new AbortController()
      this.activeDelivery = { loopId: claim.loop.loopId, controller }
      let outcome: LoopTickOutcome = 'skipped'
      let pending = claim.loop.pendingCompletion
      let newCheckInClaim = false
      try {
        if (!isCurrent()) continue
        if (pending && claim.loop.lastOutcome === 'unknown') {
          outcome = await this.onTick(claim.loop, pending.operationId, isCurrent, controller.signal)
        } else {
          // Source truth qualifies only a new continuation, never an already-frozen unknown operation.
          if (claim.loop.taskSource) {
            const source = await readContinuousProgressTaskSource(claim.loop.taskSource, controller.signal)
            if (!isCurrent()) continue
            this.patch(claim.loop.loopId, { lastDecision: source.reason, ...(source.action === 'stop' ? { status: 'stopped' as const, lastOutcome: 'skipped' as const } : source.action === 'pause' ? { status: 'paused' as const, lastOutcome: 'skipped' as const } : {}) })
            if (source.action !== 'continue') { await this.persist(claim.loop.loopId); continue }
          }
          const observation = await this.observe(claim.loop, claim.tickId, now ?? Date.now(), controller.signal)
          if (!isCurrent()) continue
          const futureIntent = claim.loop.calendar && claim.loop.futureIntentId ? { intentId: claim.loop.futureIntentId, occurrenceAt: claim.loop.nextCheckAt } : undefined
          const decision = futureIntent ? decideFutureProgress(observation, futureIntent) : decideContinuousProgress({ ...observation, ...(claim.loop.lastCompletionId ? { lastCompletionId: claim.loop.lastCompletionId } : {}) })
          if (decision.kind === 'skip') this.patch(claim.loop.loopId, { lastDecision: decision.reason })
          if (decision.kind === 'send' && observation.inputByte !== null) {
            if (claim.loop.checkIn && !pending) {
              let human: CheckInObservation
              try { human = this.futureInputs?.observeCheckIn ? await this.futureInputs.observeCheckIn(claim.loop, checkAt, controller.signal) : { known: false, reason: 'The original conversation observation owner is unavailable.' } }
              catch (error) { human = { known: false, reason: 'Current conversation facts are unconfirmed. ' + (error instanceof Error ? error.message : String(error)) } }
              if (!isCurrent()) continue
              const eligibility = decideCheckIn(this.require(claim.loop.loopId), human, checkAt)
              this.patch(claim.loop.loopId, { lastDecision: eligibility.reason, ...(!eligibility.send ? { checkInState: eligibility.state } : {}) })
              if (!eligibility.send) { await this.persist(claim.loop.loopId); continue }
              this.patch(claim.loop.loopId, { checkInState: eligibility.state })
              newCheckInClaim = true
            }
            // A pending operation is retried only by explicit resume and keeps its identity.
            // If the observed completion changed, the old claim has no authority to send.
            if (!pending) pending = { id: futureIntent ? `${futureIntent.intentId}@${futureIntent.occurrenceAt}` : decision.completionId, operationId: claim.tickId,
              condition: agentPromptCondition(observation.session), inputByte: observation.inputByte,
              prompt: claim.loop.prompt, agentMuxNote: AGENTMUX_AGENT_MESSAGING_GUIDANCE + (claim.loop.checkIn ? '\n\n' + AGENT_SCHEDULE_CHECK_IN_GUIDANCE : ''), ...(futureIntent ? { futureIntent } : {}) }
            if (futureIntent || pending.id === decision.completionId) {
              this.patch(claim.loop.loopId, { pendingCompletion: pending })
              await this.store.save(this.scheduler.list())
              if (!isCurrent()) continue
              outcome = await this.onTick({ ...claim.loop, pendingCompletion: pending }, pending.operationId, isCurrent, controller.signal)
            }
          }
        }
      } catch (error) {
        outcome = 'unknown'
        this.patch(claim.loop.loopId, { lastDecision: error instanceof Error ? error.message : String(error) })
      }
      finally { this.activeDelivery = undefined }
      const current = this.scheduler.list().find((loop) => loop.loopId === claim.loop.loopId)
      if (current) {
        if (outcome === 'unknown') this.patch(current.loopId, {
          ...(current.status === 'active' ? { status: 'paused' } : {}), lastOutcome: 'unknown'
        })
        else {
          const { pendingCompletion: _, ...settled } = current
          if (outcome === 'skipped' && newCheckInClaim && settled.checkInState) {
            const { unanswered: _, ...state } = settled.checkInState
            settled.checkInState = state
            settled.lastDecision = 'This follow-up was not delivered. The original due occurrence remains available.'
          }
          if (outcome === 'sent') {
            if (current.taskSource && settled.lastDecision) settled.lastDecision += ' Host accepted the request; a new Agent turn is not yet confirmed.'
            else delete settled.lastDecision
            if (current.calendar && pending?.futureIntent) {
              const nextDue = nextCalendarOccurrence(current.calendar, checkAt)
              settled.lastOccurrenceAt = pending.futureIntent.occurrenceAt
              settled.nextCheckAt = nextDue ?? current.nextCheckAt
              if (nextDue === null) settled.status = 'stopped'
              settled.lastDecision = 'Host accepted the original future message; a new Agent turn is not yet confirmed.'
            }
          }
          this.scheduler.restore(this.scheduler.list().map((loop) => loop.loopId === current.loopId
            ? { ...settled, lastOutcome: outcome, ...(outcome === 'sent' && pending ? { lastCompletionId: pending.id } : {}) } : loop))
        }
      }
      await this.persist(claim.loop.loopId)
    }
  }
  private cancelDelivery(loopId: string): void {
    if (this.activeDelivery?.loopId === loopId) this.activeDelivery.controller.abort()
  }
  private patch(loopId: string, patch: Partial<ContinuousProgressLoop>): void {
    this.scheduler.restore(this.scheduler.list().map((loop) => loop.loopId === loopId ? { ...loop, ...patch } : loop))
  }
}
