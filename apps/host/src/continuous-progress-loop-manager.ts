import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import { AgentMuxError, AGENTMUX_AGENT_MESSAGING_ENTRY, ContinuousProgressScheduler, isAgentSchedule, agentPromptCondition, decideContinuousProgress, decideFutureProgress, mintObjectId, type ContinuousProgressLoop, type ContinuousProgressTarget, type ContinuousProgressObservation, type ContinuousProgressTaskSource, type AgentPromptCondition } from '@agentmux/core'
import { parseScheduleRpcParams, type ScheduleMethod, type ScheduleParamsMap, type ScheduleResultMap, type AgentMuxRpcCallContext } from '@agentmux/core'
import { nextCalendarOccurrence, latestCalendarOccurrence, nextIntervalOccurrence, latestIntervalOccurrence } from '@agentmux/core/schedule-calendar'
import { readContinuousProgressTaskSource, validateContinuousProgressTaskSource, decideGoalProgressSource, type GoalProgressReader, type GoalProgressRecord } from './continuous-progress-task-source.js'
import type { ContinuousProgressLoopStore } from './continuous-progress-loop-store.js'
import { AGENT_SCHEDULE_CHECK_IN_GUIDANCE } from '@agentmux/core/schedule'
import { decideCheckIn, type CheckInObservation } from './agent-schedule-check-in.js'

export type LoopTickOutcome = 'sent' | 'skipped' | 'unknown'
export type LoopTickHandler = (loop: ContinuousProgressLoop, operationId: string, isCurrent: () => boolean, signal: AbortSignal) => Promise<LoopTickOutcome>
export type LoopObservationProvider = (loop: ContinuousProgressLoop, tickId: string, now: number, signal: AbortSignal) => Promise<ContinuousProgressObservation>
export type GoalProgressOwner = {
  read: GoalProgressReader
  subscribe?(listener: (goals: readonly GoalProgressRecord[]) => void): () => void
  inspectInitial(loop: ContinuousProgressLoop): Promise<'confirmed' | 'pending' | 'unconfirmed'>
}
export type GoalProgressStart = ContinuousProgressTarget & { goalId: string; alignmentRevision: number; intervalMs: number; operationId: string; prompt: string }

export type FutureProgressInputOwner = {
  saveFutureIntent(loop: ContinuousProgressLoop, active: boolean, context?: AgentMuxRpcCallContext): Promise<void>
  authorizeFutureIntent?(target: ContinuousProgressTarget, context?: AgentMuxRpcCallContext): Promise<void>
  observeCheckIn?(target: ContinuousProgressTarget, now: number, signal: AbortSignal): Promise<CheckInObservation>
}




export type GoalProgressInputOwner = {
  authorizeFutureIntent(target: ContinuousProgressTarget, context?: AgentMuxRpcCallContext): Promise<void>
}
export type LoopMutationFence = { prepare(): Promise<void>; assertCurrent(): void }

// These are original execution/scheduler facts. Human-facing explanations and
// later tick observations do not confer or revoke control authority.
const actionBasis = (loop: ContinuousProgressLoop) => ({ loopId: loop.loopId, hostId: loop.hostId, agentSessionId: loop.agentSessionId,
  providerId: loop.providerId, workspacePath: loop.workspacePath, intervalMs: loop.intervalMs, prompt: loop.prompt,
  taskSource: loop.taskSource, creationOperationId: loop.creationOperationId, status: loop.status, revision: loop.revision ?? 0 })

// Canonicalize the complete original RPC request, including its expected loop.
const updateDigest = (input: unknown): string => {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, canonical(v)])) : value
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
}

/** Host owner: scheduler and durable store stay together; renderer only observes results. */
export class ContinuousProgressLoopManager {
  private readonly scheduler: ContinuousProgressScheduler
  private timer: ReturnType<typeof setInterval> | null = null
  private checkPromise: Promise<void> | null = null
  private running = false
  private started: Promise<void> | undefined
  private readonly listeners = new Set<(loop: ContinuousProgressLoop) => void>()
  private readonly initialDeliveries = new Map<string, AbortController>()
  private readonly activations = new Map<string, Set<AbortController>>()
  private activeDelivery: { loopId: string; controller: AbortController } | undefined
  private readonly disposeGoals: (() => void) | undefined
  private readonly mutations = new Map<string, Promise<unknown>>()
  private readonly progressActions = new Map<string, { input: import('@agentmux/core').AgentProgressParams['agent.progress.action']; result: Promise<ContinuousProgressLoop> }>()
  constructor(private readonly store: ContinuousProgressLoopStore, private readonly onTick: LoopTickHandler, private readonly now: (() => number) = Date.now, private readonly observe: LoopObservationProvider, private readonly futureInputs?: FutureProgressInputOwner, private readonly goals?: GoalProgressOwner) {
    this.scheduler = new ContinuousProgressScheduler({ now })
    this.disposeGoals = goals?.subscribe?.(records => {
      const current = new Map(records.map(goal => [goal.id, goal]))
      for (const loop of this.list()) {
        if (loop.status === 'stopped' || loop.taskSource?.kind !== 'goal') continue
        const goal = current.get(loop.taskSource.goalId), source = decideGoalProgressSource(loop.taskSource, goal)
        if (source.action === 'continue' && goal?.sessionIds.includes(loop.agentSessionId)) continue
        // Confirmed original owner updates cancel any in-flight input synchronously.
        this.cancelDelivery(loop.loopId)
        this.patch(loop.loopId, { status: source.action === 'stop' ? 'stopped' : 'paused', lastDecision: source.action === 'continue' ? 'The original Session association changed; inspect this Goal.' : source.reason })
        void this.persist(loop.loopId).catch(() => {})
      }
    })
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
    this.disposeGoals?.()
    this.activeDelivery?.controller.abort()
    for (const controller of this.initialDeliveries.values()) controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.checkPromise?.catch(() => {})
    await this.store.save(this.scheduler.list())
  }
  list(target?: Readonly<Partial<ContinuousProgressTarget>>): ContinuousProgressLoop[] { return this.scheduler.list(target) }
  /** Initial Goal input and continuation share this original durable loop, never a second journal. */
  async prepareGoal(input: GoalProgressStart, context?: AgentMuxRpcCallContext): Promise<ContinuousProgressLoop> {
    return this.serialize(`goal-start-operation:${input.operationId}`, () => this.serialize(`goal-start-goal:${input.goalId}`, () => this.serialize(`goal-target:${input.hostId}:${input.agentSessionId}`, () => this.activation(this.targetKey(input), async assertCurrent => {
      await this.start()
      await this.authorizeCaller(input, context)
      const matches = this.list().filter(loop => loop.creationOperationId === input.operationId)
      if (matches.length > 1) throw new AgentMuxError('This original start has ambiguous saved loop facts. Its operations and Agents are retained.', 'CONTROL_REQUEST_CONFLICT')
      const existing = matches[0]
      if (existing) {
        if (existing.taskSource?.kind !== 'goal' || existing.taskSource.goalId !== input.goalId || existing.taskSource.alignmentRevision !== input.alignmentRevision ||
            existing.intervalMs !== input.intervalMs || existing.initialDelivery?.prompt !== input.prompt ||
            ['hostId', 'agentSessionId', 'providerId', 'workspacePath'].some(key => existing[key as keyof ContinuousProgressTarget] !== input[key as keyof ContinuousProgressTarget])) throw new AgentMuxError('The original start operation belongs to different Goal content or target.', 'CONTROL_REQUEST_CONFLICT')
        return existing
      }
      // Reconciliation above belongs to the frozen original operation. Only a new loop
      // consumes today's Supervisor selection; changing it never retargets the old loop.
      const goal = await this.goals?.read(input.goalId)
      if (!goal || goal.id !== input.goalId || !goal.assigneeSessionIds.includes(input.agentSessionId) || goal.supervisorSessionId !== input.agentSessionId) throw new AgentMuxError('Choose and save this exact responsible Session as the Goal Supervisor before starting Continue.', 'INVALID_CONTROL_REQUEST')
      if (this.list().some(loop => loop.taskSource?.kind === 'goal' && loop.taskSource.goalId === input.goalId && loop.status !== 'stopped')) throw new AgentMuxError('A continuation already exists for this Goal. Inspect and explicitly stop the original loop before starting a new Supervisor.', 'CONTROL_REQUEST_CONFLICT')
      const source: ContinuousProgressTaskSource = { kind: 'goal', goalId: input.goalId, alignmentRevision: input.alignmentRevision }
      const decision = await readContinuousProgressTaskSource(source, new AbortController().signal, this.goals?.read)
      if (decision.action !== 'continue') throw new AgentMuxError(decision.reason, 'CONTROL_REQUEST_CONFLICT')
      if (input.prompt !== (goal.description.trim() || goal.title)) throw new AgentMuxError('The Goal content changed before its start was saved. Inspect and explicitly start its current scope.', 'CONTROL_REQUEST_CONFLICT')
      const observation = await this.observe({ ...input, loopId: input.operationId, prompt: input.prompt, nextCheckAt: this.now(), status: 'paused' }, input.operationId, this.now(), new AbortController().signal)
      if (observation.session.agentSessionId !== input.agentSessionId || observation.session.hostId !== input.hostId || observation.session.providerId !== input.providerId || observation.session.workspacePath !== input.workspacePath) throw new AgentMuxError('The exact original Agent target is unconfirmed.', 'STALE_AGENT_SESSION')
      if (observation.inputOccupied) throw new AgentMuxError('Keep your draft and queued messages. Clear them before enabling automatic progress.', 'CONTROL_REQUEST_CONFLICT')
      const initialDelivery = { operationId: input.operationId, prompt: input.prompt, condition: agentPromptCondition(observation.session), state: 'prepared' as const, startedAt: this.now() }
      const prompt = `Continue the original Goal ${goal.id} within its confirmed scope r${input.alignmentRevision}. Inspect it with amux goal inspect --goal ${JSON.stringify(goal.id)} before working. Report real progress, decisions and file evidence through the original Goal. Stop when done or cancelled; do not claim human acceptance.\n\n${goal.description.trim() || goal.title}\n\nConfirmed criteria:\n${goal.alignment!.criteria.map(c => '- ' + c.text).join('\n')}`
      assertCurrent()
      const loop = this.scheduler.create({ ...input, prompt, taskSource: source, operationId: input.operationId, initialDelivery })
      await this.persist(loop.loopId)
      return this.require(loop.loopId)
    }))))
  }
  async listGoals(goalId: string): Promise<ContinuousProgressLoop[]> {
    await this.start()
    return this.list().filter(loop => loop.taskSource?.kind === 'goal' && loop.taskSource.goalId === goalId)
  }
  /** A queue retry joins original Core admission; a lost receipt never reconstructs another message. */
  async initialGoalInput(target: ContinuousProgressTarget, loopId: string, operationId: string, phase: 'begin' | 'confirm'): Promise<ContinuousProgressLoop> {
    return this.serialize(loopId, async () => {
      await this.start()
      const loop = this.require(loopId), initial = loop.initialDelivery
      if (loop.taskSource?.kind !== 'goal' || !initial || initial.operationId !== operationId ||
          ['hostId', 'agentSessionId', 'providerId', 'workspacePath'].some(key => loop[key as keyof ContinuousProgressTarget] !== target[key as keyof ContinuousProgressTarget])) throw new AgentMuxError('The original Goal input target or operation is unconfirmed.', 'CONTROL_REQUEST_CONFLICT')
      if (phase === 'begin' && loop.status === 'stopped') throw new AgentMuxError('This original Goal loop was stopped. Its operation and Agent are retained; no input was sent.', 'CONTROL_REQUEST_CONFLICT')
      const source = await this.goalSource(loop)
      if (phase === 'begin' && this.require(loopId).status === 'stopped') throw new AgentMuxError('This original Goal loop was stopped. Its operation and Agent are retained; no input was sent.', 'CONTROL_REQUEST_CONFLICT')
      if (phase === 'begin' && source.action !== 'continue') {
        await this.pauseForSource(loop, source)
        throw new AgentMuxError(source.reason, 'CONTROL_REQUEST_CONFLICT')
      }
      if (initial.state === 'confirmed') return this.require(loopId)
      if (!this.goals) throw new AgentMuxError('The original Goal input receipt owner is unavailable.', 'CONTROL_UNAVAILABLE')
      const receipt = await this.goals.inspectInitial(loop)
      const current = this.require(loopId)
      if (phase === 'begin' && current.status === 'stopped') throw new AgentMuxError('This original Goal loop was stopped. Its operation and Agent are retained; no input was sent.', 'CONTROL_REQUEST_CONFLICT')
      if (receipt === 'confirmed') {
        this.patch(loopId, { initialDelivery: { ...initial, state: 'confirmed' }, ...(current.status === 'stopped' || source.action === 'stop' ? { status: 'stopped' as const } : source.action === 'pause' ? { status: 'paused' as const } : !current.lastMutation ? { status: 'active' as const, nextCheckAt: this.now() + loop.intervalMs } : {}), lastDecision: source.reason })
        await this.persist(loopId)
        return this.require(loopId)
      }
      if (phase === 'confirm' || initial.state === 'unknown' && receipt !== 'pending') {
        this.patch(loopId, { status: current.status === 'stopped' ? 'stopped' : 'paused', lastOutcome: 'unknown', lastDecision: 'Original Goal input delivery is unconfirmed. Inspect this same operation and its original outbox; the Agent and manual input remain available.' })
        await this.persist(loopId)
        throw new AgentMuxError('The original Goal input transaction cannot be confirmed. No new operation was sent.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
      }
      this.patch(loopId, { initialDelivery: { ...initial, state: 'unknown' }, status: 'paused', lastDecision: 'The original Goal input is being submitted; its receipt is not yet confirmed.' })
      await this.persist(loopId)
      return this.require(loopId)
    })
  }
  /** The original input port keeps a Goal's live source guard through Core's native write. */
  async submitGoalInitial(target: Pick<ContinuousProgressTarget, 'hostId' | 'agentSessionId'>, goalId: string, loopId: string, operationId: string,
    prompt: string, condition: AgentPromptCondition,
    send: (isCurrent: () => boolean, signal: AbortSignal) => Promise<void>): Promise<void> {
    await this.start()
    const original = this.require(loopId)
    if (original.hostId !== target.hostId || original.agentSessionId !== target.agentSessionId) throw new AgentMuxError('The original Goal input belongs to another Agent.', 'CONTROL_REQUEST_CONFLICT')
    const prepared = await this.initialGoalInput(original, loopId, operationId, 'begin')
    if (prepared.taskSource?.kind !== 'goal' || prepared.taskSource.goalId !== goalId ||
        prepared.initialDelivery?.prompt !== prompt || JSON.stringify(prepared.initialDelivery.condition) !== JSON.stringify(condition)) throw new AgentMuxError('The original Goal message body or frozen condition changed. Your input is kept.', 'CONTROL_REQUEST_CONFLICT')
    if (prepared.initialDelivery.state === 'confirmed') return
    const controller = new AbortController()
    this.initialDeliveries.get(loopId)?.abort()
    this.initialDeliveries.set(loopId, controller)
    const isCurrent = () => this.running && !controller.signal.aborted && this.initialDeliveries.get(loopId) === controller &&
      this.list().some(loop => loop.loopId === loopId && loop.status !== 'stopped' && loop.revision === prepared.revision && loop.initialDelivery?.operationId === operationId)
    try {
      const source = await this.goalSource(this.require(loopId))
      if (source.action !== 'continue') { await this.pauseForSource(prepared, source); throw new AgentMuxError(source.reason, 'CONTROL_REQUEST_CONFLICT') }
      if (!isCurrent()) throw new AgentMuxError('The original Goal input was cancelled. Its message and Agent remain available.', 'CONTROL_REQUEST_CONFLICT')
      await send(isCurrent, controller.signal)
      await this.initialGoalInput(prepared, loopId, operationId, 'confirm')
    } finally { if (this.initialDeliveries.get(loopId) === controller) this.initialDeliveries.delete(loopId) }
  }
  async goalAction(goalId: string, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check', expectedRevision: number, operationId: string, context?: AgentMuxRpcCallContext): Promise<ContinuousProgressLoop> {
    return this.serialize(loopId, () => this.activation(loopId, async assertActivation => {
      await this.start()
      const loop = this.require(loopId)
      if (loop.taskSource?.kind !== 'goal' || loop.taskSource.goalId !== goalId) throw new AgentMuxError('This loop does not belong to the exact Goal.', 'CONTROL_REQUEST_CONFLICT')
      await this.authorizeCaller(loop, context)
      if (this.require(loopId).status === 'stopped' && action !== 'stop') throw new AgentMuxError('This original Goal loop was stopped. Its operation and Agent are retained; inspect it before explicitly starting new work.', 'CONTROL_REQUEST_CONFLICT')
      const retry = loop.lastMutation?.operationId === operationId
      if (retry) {
        if (loop.lastMutation?.action !== action || loop.lastMutation?.expectedRevision !== expectedRevision) throw new AgentMuxError('This original loop operation has different content.', 'CONTROL_REQUEST_CONFLICT')
        if (action === 'check') { await this.persist(loopId); return this.require(loopId) }
      }
      if (!retry && loop.revision !== expectedRevision) throw new AgentMuxError('The original loop revision changed. Inspect before another action.', 'CONTROL_REQUEST_CONFLICT')
      if (action === 'resume' || action === 'check') {
        const source = await this.goalSource(loop)
        if (source.action !== 'continue') { await this.pauseForSource(loop, source); throw new AgentMuxError(source.reason, 'CONTROL_REQUEST_CONFLICT') }
        if (action === 'check' && loop.status !== 'active') throw new AgentMuxError('Resume this original loop before checking it.', 'CONTROL_REQUEST_CONFLICT')
        if (loop.status === 'stopped' || loop.initialDelivery?.state !== 'confirmed') throw new AgentMuxError('The original start receipt is unconfirmed or this loop is stopped. Inspect it before another action.', 'CONTROL_REQUEST_CONFLICT')
        const observed = await this.observe(loop, operationId, this.now(), new AbortController().signal)
        if (observed.inputOccupied || observed.session.run.runId !== loop.initialDelivery.condition.expectedRun.runId) throw new AgentMuxError('Your draft, queue or original Run changed. Automatic progress stays paused; manual input is retained.', 'CONTROL_REQUEST_CONFLICT')
        context?.signal?.throwIfAborted(); await context?.assertCurrent?.()
        assertActivation()
        if (!isDeepStrictEqual(actionBasis(this.require(loopId)), actionBasis(loop)) || this.require(loopId).revision !== loop.revision)
          throw new AgentMuxError('The original Goal loop changed during action preparation. Its current state and manual input are retained.', 'CONTROL_REQUEST_CONFLICT')
      }
      if (this.require(loopId).status === 'stopped' && action !== 'stop') throw new AgentMuxError('This original Goal loop was stopped. Its operation and Agent are retained; inspect it before explicitly starting new work.', 'CONTROL_REQUEST_CONFLICT')
      this.patch(loopId, { ...(!retry ? { revision: expectedRevision + 1, lastMutation: { operationId, action, expectedRevision } } : {}),
        ...(action === 'pause' ? { status: 'paused' as const, lastDecision: 'Paused by you.' } : action === 'stop' ? { status: 'stopped' as const } : action === 'resume' ? { status: 'active' as const, nextCheckAt: this.now() + loop.intervalMs } : {}) })
      if (action === 'pause' || action === 'stop') this.cancelDelivery(loopId)
      // Pure state changes and the operation are one durable write. A retry repeats that same state;
      // a check persists its operation before the original scheduler can cross the input boundary.
      await this.persist(loopId)
      if (action === 'check') await this.checkNow(loopId, assertActivation)
      return this.require(loopId)
    }))
  }
  private async serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(action)
    this.mutations.set(key, operation)
    try { return await operation } finally { if (this.mutations.get(key) === operation) this.mutations.delete(key) }
  }
  /** Cancellation also fences asynchronous resume/check preparation, even if
   * the saved loop was already paused and its durable fields need no change. */
  private async activation<T>(loopId: string, action: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    const controller = new AbortController(), pending = this.activations.get(loopId) ?? new Set<AbortController>()
    pending.add(controller); this.activations.set(loopId, pending)
    try { return await action(() => {
      if (controller.signal.aborted) throw new AgentMuxError('The original automatic action was cancelled. Its loop and healthy manual input are retained.', 'CONTROL_REQUEST_CONFLICT')
    }) } finally { pending.delete(controller); if (!pending.size) this.activations.delete(loopId) }
  }
  private targetKey(target: Pick<ContinuousProgressTarget, 'hostId' | 'agentSessionId'>): string { return 'target:' + JSON.stringify([target.hostId, target.agentSessionId]) }
  /** Exact target cancellation revokes preparations as well as already active delivery. */
  cancelTarget(target: Pick<ContinuousProgressTarget, 'hostId' | 'agentSessionId'>): void {
    for (const controller of this.activations.get(this.targetKey(target)) ?? []) controller.abort()
    for (const loop of this.list(target)) this.cancelDelivery(loop.loopId)
  }
  private async goalSource(loop: ContinuousProgressLoop): Promise<{ action: 'continue' | 'pause' | 'stop'; reason: string }> {
    if (loop.taskSource?.kind !== 'goal') return { action: 'continue', reason: '' }
    try {
      return await readContinuousProgressTaskSource(loop.taskSource, new AbortController().signal, async goalId => {
        const goal = await this.goals?.read(goalId)
        if (!goal || !goal.sessionIds.includes(loop.agentSessionId)) throw new Error('The exact Session is no longer associated with this Goal. Original input and Agent are retained.')
        return goal
      })
    } catch (error) { return { action: 'pause', reason: 'Reading the original Goal is unconfirmed. Its loop, outbox and manual Agent input are kept. Restore the Goal owner and inspect before resuming. ' + (error instanceof Error ? error.message : String(error)) } }

  }
  private async pauseForSource(loop: ContinuousProgressLoop, source: { action: 'continue' | 'pause' | 'stop'; reason: string }): Promise<void> {
    this.patch(loop.loopId, { status: this.require(loop.loopId).status === 'stopped' || source.action === 'stop' ? 'stopped' : 'paused', lastDecision: source.reason })
    this.cancelDelivery(loop.loopId)
    await this.persist(loop.loopId)
  }
  async call<M extends ScheduleMethod>(method: M, input: ScheduleParamsMap[M], context?: AgentMuxRpcCallContext): Promise<ScheduleResultMap[M]> {
    const params = parseScheduleRpcParams(method, input)
    if (method === 'schedule.create' && (params as ScheduleParamsMap['schedule.create']).checkIn &&
        (context?.caller || !context?.principal || !['user','device'].includes(context.principal.kind))) throw new AgentMuxError('Quiet follow-up requires explicit opt-in from the authenticated user or device. Existing arrangements and manual input remain available.', 'SCHEDULE_CHECK_IN_OPT_IN_REQUIRED')
    if (method === 'schedule.list' || method === 'schedule.inspect') return this.callOwned(method, params, context)
    const create = params as ScheduleParamsMap['schedule.create']
    const key = method === 'schedule.create' ? create.checkIn ? 'checkin:' + JSON.stringify([create.target.hostId, create.target.agentSessionId, create.target.providerId, create.target.workspacePath]) : `create:${create.operationId}` : (params as ScheduleParamsMap['schedule.pause']).scheduleId
    const previous = this.mutations.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => method === 'schedule.create'
      ? this.activation(this.targetKey(create.target), assertCurrent => this.callOwned(method, params, context, assertCurrent))
      : this.callOwned(method, params, context))
    this.mutations.set(key, operation)
    try { return await operation } finally { if (this.mutations.get(key) === operation) this.mutations.delete(key) }
  }
  private async callOwned<M extends ScheduleMethod>(method: M, input: ScheduleParamsMap[M], context?: AgentMuxRpcCallContext, assertCurrent?: () => void): Promise<ScheduleResultMap[M]> {
    const params = parseScheduleRpcParams(method, input)
    await this.start()
    const scope = { executionScope: 'connected-host' as const }
    if (method === 'schedule.list') {
      const { target, scope: directory } = params as ScheduleParamsMap['schedule.list']
      return { ...scope, schedules: this.scheduler.list(target ?? directory).filter(isAgentSchedule) } as ScheduleResultMap[M]
    }
    if (method === 'schedule.inspect') {
      const p = params as ScheduleParamsMap['schedule.inspect']
      return { ...scope, schedule: this.list().find(loop => isAgentSchedule(loop) && (p.scheduleId ? loop.loopId === p.scheduleId : loop.creationOperationId === p.operationId || loop.lastMutation?.operationId === p.operationId || loop.pendingCompletion?.operationId === p.operationId || loop.lastTickId === p.operationId)) ?? null } as ScheduleResultMap[M]
    }
    if (method === 'schedule.create') {
      const p = params as ScheduleParamsMap['schedule.create']
      if (p.checkIn && (context?.caller || !context?.principal || !['user','device'].includes(context.principal.kind))) throw new AgentMuxError('Quiet follow-up requires explicit opt-in from the authenticated user or device. Existing arrangements and manual input remain available.', 'SCHEDULE_CHECK_IN_OPT_IN_REQUIRED')
      await this.authorizeCaller(p.target, context)
      const existing = this.list().find(loop => loop.creationOperationId === p.operationId)
      if (existing) {
        if (existing.prompt !== p.prompt || JSON.stringify(existing.calendar) !== JSON.stringify(p.calendar) || existing.afterMs !== p.afterMs || existing.everyMs !== p.everyMs || JSON.stringify(existing.checkIn) !== JSON.stringify(p.checkIn) || ['hostId','agentSessionId','providerId','workspacePath'].some(key => existing[key as keyof ContinuousProgressTarget] !== p.target[key as keyof ContinuousProgressTarget])) throw new AgentMuxError('Schedule operation was reused with conflicting target or content.', 'SCHEDULE_OPERATION_CONFLICT')
        if (!this.futureInputs) throw new AgentMuxError('Future-message admission durability is unconfirmed.', 'SCHEDULE_INPUT_OWNER_UNAVAILABLE')
        const retryCreation = existing.status === 'paused' && existing.lastOutcome === 'unknown' && !existing.lastTickId && !existing.lastMutation
        try { await this.saveFutureIntent(existing, retryCreation || existing.status === 'active', context); assertCurrent?.() }
        catch (error) {
          this.patch(existing.loopId, { status: 'paused', lastOutcome: 'unknown', lastDecision: 'The original future-message preparation was cancelled or unconfirmed. Inspect the same operation.' })
          await this.persist(existing.loopId); await this.saveFutureIntent(this.require(existing.loopId), false, context); throw error
        }
        if (retryCreation && this.require(existing.loopId).status !== 'stopped' && !this.require(existing.loopId).lastMutation) {
          const { lastOutcome: _, lastDecision: __, ...confirmed } = this.require(existing.loopId)
          this.scheduler.replace(existing.loopId, { ...confirmed, status: 'active' })
        }
        await this.persist(existing.loopId)
        return { ...scope, schedule: this.require(existing.loopId), diskDurability: 'confirmed' } as ScheduleResultMap[M]
      }
      if (!this.futureInputs) throw new AgentMuxError('The connected Host cannot save future-message admission. The Agent and manual input remain available.', 'SCHEDULE_INPUT_OWNER_UNAVAILABLE')
      if (p.checkIn && this.list().some(loop => loop.checkIn && loop.status !== 'stopped' && ['hostId','agentSessionId','providerId','workspacePath'].every(key => loop[key as keyof ContinuousProgressTarget] === p.target[key as keyof ContinuousProgressTarget]))) throw new AgentMuxError('This Agent already has a saved quiet follow-up. Inspect, pause or cancel that original arrangement.', 'SCHEDULE_CHECK_IN_EXISTS')
      const nextDue = p.calendar ? nextCalendarOccurrence(p.calendar, this.now()) : this.now() + (p.afterMs ?? p.everyMs!)
      if (nextDue !== null && (!Number.isSafeInteger(nextDue) || nextDue < 0 || p.everyMs !== undefined && !Number.isFinite(new Date(nextDue).getTime()))) throw new AgentMuxError('The requested delay exceeds the safe absolute schedule clock. Choose a representable delay; the Agent and manual input remain available.', 'INVALID_CONTROL_REQUEST')
      if (nextDue === null) throw new AgentMuxError('This one-time civil occurrence is past or falls in a skipped DST gap. Choose a valid future time.', 'SCHEDULE_NO_FUTURE_OCCURRENCE')
      assertCurrent?.()
      const loop = this.scheduler.createSchedule({ ...p.target, prompt: p.prompt, nextDue, operationId: p.operationId, ...(p.calendar ? { calendar: p.calendar, ...(p.checkIn ? { checkIn: p.checkIn } : {}) } : p.afterMs !== undefined ? { afterMs: p.afterMs } : { everyMs: p.everyMs! }) })
      this.patch(loop.loopId, { status: 'paused' })
      try { await this.persist(loop.loopId); assertCurrent?.(); await this.saveFutureIntent(loop, true, context); assertCurrent?.(); this.patch(loop.loopId, { status: 'active' }); await this.persist(loop.loopId) }
      catch (error) { this.patch(loop.loopId, { status: 'paused', lastOutcome: 'unknown', lastDecision: 'Saving the future-message intent is unconfirmed. Inspect the original operation; manual input remains available.' }); await this.persist(loop.loopId); await this.saveFutureIntent(this.require(loop.loopId), false, context); throw error }
      return { ...scope, schedule: this.require(loop.loopId), diskDurability: 'confirmed' } as ScheduleResultMap[M]
    }
    const p = params as ScheduleParamsMap['schedule.pause'], action = method.slice('schedule.'.length) as 'pause' | 'resume' | 'cancel'
    let loop = this.require(p.scheduleId)
    if (!isAgentSchedule(loop)) throw new AgentMuxError('This public operation requires a saved schedule.', 'UNKNOWN_SCHEDULE')
    await this.authorizeCaller(loop, context)
    loop = this.require(p.scheduleId)
    if (loop.lastMutation?.operationId === p.operationId) {
      if (loop.lastMutation.action !== action || loop.lastMutation.expectedRevision !== p.expectedRevision) throw new AgentMuxError('Schedule mutation operation conflicts with the original action.', 'SCHEDULE_OPERATION_CONFLICT')
    } else {
      if ((loop.revision ?? 0) !== p.expectedRevision) throw new AgentMuxError('Schedule revision changed. Inspect the original arrangement before editing.', 'SCHEDULE_REVISION_CONFLICT')
    }
    if (loop.status === 'stopped' && action !== 'cancel') throw new AgentMuxError('An ended arrangement cannot pause or resume. Inspect the original arrangement; save a new one explicitly for new work.', 'SCHEDULE_CANCELLED')
    if (loop.lastMutation?.operationId !== p.operationId) this.patch(loop.loopId, { revision: p.expectedRevision + 1, lastMutation: { operationId: p.operationId, action, expectedRevision: p.expectedRevision } })
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
  private async saveFutureIntent(loop: ContinuousProgressLoop, active: boolean, context?: AgentMuxRpcCallContext): Promise<void> {
    const current = this.require(loop.loopId), activating = active && current.status !== 'stopped'
    await this.futureInputs?.saveFutureIntent(current, activating, context)
    // An earlier activation may finish after cancellation. Converge the same intent;
    // a late callback must not reopen its Core qualification or its saved schedule.
    if (activating && this.require(loop.loopId).status === 'stopped') await this.futureInputs?.saveFutureIntent(this.require(loop.loopId), false, context)
  }
  async callProgress<M extends import('@agentmux/core').AgentProgressMethod>(method: M, input: import('@agentmux/core').AgentProgressParams[M], context: AgentMuxRpcCallContext): Promise<import('@agentmux/core').AgentProgressResults[M]> {
    const target = input.target
    const activationAuthority = () => {
      if (context.caller || !context.principal || !['user','device'].includes(context.principal.kind))
        throw new AgentMuxError('Continuous progress activation requires the original person or device arrangement. Agent message authority does not authorize Host automatic input or task-source scripts; reading, cancellation and normal Agent messages remain available.', 'CONTROL_PERMISSION_DENIED')
    }
    if (method === 'agent.progress.create' || method === 'agent.progress.update' || method === 'agent.progress.action' && 'action' in input && (input.action === 'resume' || input.action === 'check')) activationAuthority()
    const matches = (loop: ContinuousProgressLoop) => !isAgentSchedule(loop) && loop.taskSource?.kind !== 'goal' &&
      ['hostId','agentSessionId','providerId','workspacePath'].every(key => loop[key as keyof ContinuousProgressTarget] === target[key as keyof ContinuousProgressTarget])
    const value = await this.serialize('progress:' + target.hostId + ':' + target.agentSessionId, async () => {
      await this.start(); await this.authorizeCaller(target, context)
      if (method === 'agent.progress.list') return { loops: this.list(target).filter(matches) }
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (method === 'agent.progress.update') {
        const update = input as import('@agentmux/core').AgentProgressParams['agent.progress.update']
        const loop = this.require(update.loopId)
        if (!matches(loop)) throw new AgentMuxError('This progress update belongs to another exact loop target.', 'CONTROL_REQUEST_CONFLICT')
        if (loop.creationOperationId === update.operationId || this.progressActions.has(update.operationId)) throw new AgentMuxError('This operation identity belongs to another progress request.', 'CONTROL_REQUEST_CONFLICT')
        const digest = updateDigest(update), expectedRevision = update.expectedLoop.revision ?? 0
        if (loop.lastMutation?.operationId === update.operationId) {
          if (loop.lastMutation.action !== 'update' || loop.lastMutation.requestDigest !== digest || loop.lastMutation.expectedRevision !== expectedRevision || loop.revision !== expectedRevision + 1) throw new AgentMuxError('The original progress update changed content.', 'CONTROL_REQUEST_CONFLICT')
        } else {
          if (loop.status === 'stopped' || !Number.isSafeInteger(expectedRevision + 1) || !isDeepStrictEqual(actionBasis(loop), actionBasis(update.expectedLoop))) throw new AgentMuxError('The original loop changed. Read its current record before another explicit update.', 'CONTROL_REQUEST_CONFLICT')
          this.patch(loop.loopId, { intervalMs: update.intervalMs, prompt: update.prompt, revision: expectedRevision + 1,
            lastMutation: { operationId: update.operationId, action: 'update', expectedRevision, requestDigest: digest } })
        }
        // Preserve the original loop and any in-flight tick on an unconfirmed save.
        // A matching explicit retry only persists the same current record.
        try { await this.store.save(this.scheduler.list()) }
        finally { for (const listener of this.listeners) listener(this.require(loop.loopId)) }
        return { loop: this.require(loop.loopId), diskDurability: 'confirmed' as const }
      }
      if (method === 'agent.progress.create') return this.activation(this.targetKey(target), async assertCurrent => {
        const p = input as import('@agentmux/core').AgentProgressParams['agent.progress.create']
        const original = this.list().find(loop => loop.creationOperationId === p.operationId)
        if (original) {
          if (!matches(original) || original.intervalMs !== p.intervalMs || original.prompt !== p.prompt || JSON.stringify(original.taskSource) !== JSON.stringify(p.taskSource)) throw new AgentMuxError('The original progress creation belongs to another exact intent.', 'CONTROL_REQUEST_CONFLICT')
          return { loop: original, diskDurability: 'confirmed' as const }
        }
        const observed = await this.observe({ ...target, loopId: p.operationId, intervalMs: p.intervalMs, prompt: p.prompt, nextCheckAt: this.now(), status: 'paused' }, p.operationId, this.now(), context.signal ?? new AbortController().signal)
        if (observed.inputOccupied) throw new AgentMuxError('Your original explicit input intent pauses automatic progress. Manual input remains available.', 'CONTROL_REQUEST_CONFLICT')
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        assertCurrent()
        return { loop: await this.create({ ...target, intervalMs: p.intervalMs, prompt: p.prompt, operationId: p.operationId, ...(p.taskSource ? { taskSource: p.taskSource } : {}) }, assertCurrent), diskDurability: 'confirmed' as const }
      })
      const pAction = input as import('@agentmux/core').AgentProgressParams['agent.progress.action']
      const loop = this.require(pAction.loopId)
      if (!matches(loop)) throw new AgentMuxError('This progress action belongs to another exact loop target.', 'CONTROL_REQUEST_CONFLICT')
      const p = pAction
      if (loop.lastMutation?.action === 'update' && loop.lastMutation.operationId === p.operationId) throw new AgentMuxError('This operation identity belongs to another progress request.', 'CONTROL_REQUEST_CONFLICT')
      const prior = this.progressActions.get(p.operationId)
      if (prior) {
        if (!isDeepStrictEqual(prior.input, p)) throw new AgentMuxError('The original progress action changed target or content.', 'CONTROL_REQUEST_CONFLICT')
        return { loop: await prior.result, diskDurability: 'confirmed' as const }
      }
      const mutate = async (assertCurrent: () => void) => {
        if (!isDeepStrictEqual(actionBasis(this.require(loop.loopId)), actionBasis(p.expectedLoop))) throw new AgentMuxError('The original loop changed. Read its current record before another explicit action.', 'CONTROL_REQUEST_CONFLICT')
        if (p.action === 'resume' || p.action === 'check') {
          const observed = await this.observe(loop, p.operationId, this.now(), context.signal ?? new AbortController().signal)
          if (observed.inputOccupied) throw new AgentMuxError('Automatic progress remains paused for your original input intent.', 'CONTROL_REQUEST_CONFLICT')
        }
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        assertCurrent()
        if (!isDeepStrictEqual(actionBasis(this.require(loop.loopId)), actionBasis(p.expectedLoop))) throw new AgentMuxError('The original loop changed during action preparation. Read its current record before another explicit action.', 'CONTROL_REQUEST_CONFLICT')
        if (p.action === 'pause') return this.pause(loop.loopId)
        if (p.action === 'stop') return this.stopLoop(loop.loopId)
        if (p.action === 'resume') await this.resume(loop.loopId, context)
        return this.checkNow(loop.loopId, () => { context.signal?.throwIfAborted(); assertCurrent() })
      }
      const result = p.action === 'resume' || p.action === 'check' ? this.activation(loop.loopId, mutate) : mutate(() => {})
      this.progressActions.set(p.operationId, { input: structuredClone(p), result })
      return { loop: await result, diskDurability: 'confirmed' as const }
    })
    return value as import('@agentmux/core').AgentProgressResults[M]
  }
  async create(input: ContinuousProgressTarget & { intervalMs: number; prompt: string; taskSource?: ContinuousProgressTaskSource; operationId?: string }, assertCurrent?: () => void): Promise<ContinuousProgressLoop> {
    await this.start()
    if (input.taskSource !== undefined) validateContinuousProgressTaskSource(input.taskSource)
    assertCurrent?.()
    const loop = this.scheduler.create(input)
    await this.persist(loop.loopId)
    return loop
  }
  async pause(loopId: string, reason = 'Paused by you.', context?: AgentMuxRpcCallContext, fence?: LoopMutationFence): Promise<ContinuousProgressLoop> {
    const [result] = await this.pauseMany([loopId], reason, context, fence)
    if (result!.status === 'rejected') throw result!.reason
    return result!.value
  }
  /** One original cancellation batch shares a durable write, retaining each
   * loop's result and its schedule's separate Future Intent outcome. */
  async pauseMany(loopIds: readonly string[], reason: string, context?: AgentMuxRpcCallContext, fence?: LoopMutationFence): Promise<PromiseSettledResult<ContinuousProgressLoop>[]> {
    await this.start()
    const prepared = await Promise.allSettled(loopIds.map(async loopId => {
      await fence?.prepare()
      fence?.assertCurrent()
      const original = this.require(loopId)
      if (isAgentSchedule(original) && original.status === 'stopped') throw new AgentMuxError('An ended arrangement cannot pause or resume. Save a new arrangement explicitly.', 'SCHEDULE_CANCELLED')
      if (original.taskSource?.kind === 'goal' && original.status === 'stopped') return { loopId, persist: false }
      this.scheduler.pause(loopId); this.patch(loopId, { lastDecision: reason }); this.cancelDelivery(loopId)
      // Paused memory is not a save receipt. A new explicit operation also
      // persists an already paused loop, confirming a previously failed write.
      return { loopId, persist: true }
    }))
    const pending = prepared.flatMap(result => result.status === 'fulfilled' && result.value.persist ? [result.value.loopId] : [])
    let persistence: PromiseSettledResult<void> = { status: 'fulfilled', value: undefined }
    if (pending.length) [persistence] = await Promise.allSettled([this.saveLoops()])
    return await Promise.allSettled(prepared.map(async result => {
      if (result.status === 'rejected') throw result.reason
      const { loopId, persist } = result.value
      if (persist && persistence.status === 'rejected') {
        this.persistenceFailed(loopId, persistence.reason)
        throw persistence.reason
      }
      if (persist) for (const listener of this.listeners) listener(this.require(loopId))
      if (persist && isAgentSchedule(this.require(loopId))) await this.saveFutureIntent(this.require(loopId), false, context)
      return this.require(loopId)
    }))
  }
  async resume(loopId: string, context?: AgentMuxRpcCallContext): Promise<ContinuousProgressLoop> {
    return this.activation(loopId, async assertCurrent => {
    await this.start(); assertCurrent()
    const before = this.require(loopId)
    if (isAgentSchedule(before) && before.status === 'stopped') throw new AgentMuxError('An ended arrangement cannot pause or resume. Save a new arrangement explicitly.', 'SCHEDULE_CANCELLED')
    if (before.taskSource?.kind === 'goal') {
      if (before.status === 'stopped') return before
      const source = await this.goalSource(before)
      if (source.action !== 'continue' || before.initialDelivery?.state !== 'confirmed') { await this.pauseForSource(before, source); throw new AgentMuxError(source.reason || 'Original Goal input receipt is unconfirmed.', 'CONTROL_REQUEST_CONFLICT') }
    }
    if (isAgentSchedule(before)) await this.saveFutureIntent(before, true, context)
    context?.signal?.throwIfAborted(); await context?.assertCurrent?.()
    try { assertCurrent() } catch (error) {
      if (isAgentSchedule(before)) await this.saveFutureIntent(this.require(loopId), false, context)
      throw error
    }
    if (!isDeepStrictEqual(actionBasis(this.require(loopId)), actionBasis(before)) || this.require(loopId).revision !== before.revision) {
      if (isAgentSchedule(before)) await this.saveFutureIntent(this.require(loopId), false, context)
      throw new AgentMuxError('The original arrangement changed during resume. Its current state and manual input are retained.', 'CONTROL_REQUEST_CONFLICT')
    }
    const { lastDecision: _, ...loop } = this.scheduler.resume(loopId)
    this.scheduler.replace(loopId, loop)
    await this.persist(loopId)
    return loop
    })
  }
  async stopLoop(loopId: string, context?: AgentMuxRpcCallContext): Promise<ContinuousProgressLoop> {
    await this.start()
    this.scheduler.stop(loopId); this.cancelDelivery(loopId)
    await this.persist(loopId)
    if (isAgentSchedule(this.require(loopId))) await this.saveFutureIntent(this.require(loopId), false, context)
    return this.require(loopId)
  }
  async checkNow(loopId: string, assertCurrent?: () => void): Promise<ContinuousProgressLoop> {
    await this.start()
    // A manual request must reach its own target, not join another target's tick.
    // The existing tick owns its failure; it must not prevent this target's check.
    while (this.checkPromise) await this.checkPromise.catch(() => {})
    assertCurrent?.()
    if (this.require(loopId).status !== 'active') throw new Error('Resume this loop before checking it.')
    if (!isAgentSchedule(this.require(loopId))) this.scheduler.requestCheck(loopId)
    await this.check(undefined, loopId)
    return this.require(loopId)
  }
  pauseTarget(target: Pick<ContinuousProgressTarget, 'hostId' | 'agentSessionId'>, reason: string): Promise<void> {
    const changed = this.list(target).filter(loop => !isAgentSchedule(loop) && loop.status === 'active')
    for (const loop of changed) {
      this.scheduler.pause(loop.loopId); this.patch(loop.loopId, { lastDecision: reason }); this.cancelDelivery(loop.loopId)
    }
    // Cancellation is synchronous. Human input does not wait for a durable loop write.
    return Promise.all(changed.map(loop => this.persist(loop.loopId))).then(() => {})
  }
  private require(loopId: string): ContinuousProgressLoop {
    const loop = this.scheduler.get(loopId)
    if (!loop) throw new Error('Continuous progress loop is unavailable.')
    return loop
  }
  private async persist(loopId: string): Promise<void> {
    try { await this.saveLoops() }
    catch (error) { this.persistenceFailed(loopId, error); throw error }
    for (const listener of this.listeners) listener(this.require(loopId))
  }
  private saveLoops(): Promise<void> {
    return this.store.save(this.scheduler.list())
  }
  private persistenceFailed(loopId: string, error: unknown): void {
    const original = this.require(loopId)
    this.patch(loopId, { status: original.taskSource?.kind === 'goal' && original.status === 'stopped' ? 'stopped' : 'paused', lastDecision: `Loop persistence is unconfirmed. Manual input remains available. ${error instanceof Error ? error.message : String(error)}` })
    for (const listener of this.listeners) listener(this.require(loopId))
  }
  async check(now?: number, onlyLoopId?: string): Promise<void> {
    if (this.checkPromise) return await this.checkPromise
    this.checkPromise = this.checkOnce(now, onlyLoopId).finally(() => { this.checkPromise = null })
    return await this.checkPromise
  }
  private async checkOnce(now?: number, onlyLoopId?: string): Promise<void> {
    if (!this.running) return
    const checkAt = now ?? this.now()
    const due = this.scheduler.due(checkAt, onlyLoopId)
    for (const selected of due) {
      const loop = this.scheduler.get(selected.loopId)
      if (!loop || loop.status !== 'active' || loop.nextCheckAt > checkAt) continue
      if (loop.calendar && !loop.pendingCompletion) {
        const latest = latestCalendarOccurrence(loop.calendar, loop.nextCheckAt, checkAt)
        if (latest !== loop.nextCheckAt) this.patch(loop.loopId, { nextCheckAt: latest, lastDecision: 'Missed older occurrences; only the latest due occurrence is eligible.' })
      }
      if (loop.everyMs !== undefined && !loop.pendingCompletion) {
        const latest = latestIntervalOccurrence(loop.nextCheckAt, checkAt, loop.everyMs)
        if (latest !== loop.nextCheckAt) this.patch(loop.loopId, { nextCheckAt: latest, lastDecision: 'Missed older occurrences; only the latest due occurrence is eligible.' })
      }
      // A read-only probe can avoid a durable claim only for confirmed busy input.
      // Everything else still follows the original claim and final admission fence.
      let preflightFailure: unknown, preflightFailed = false
      if (isAgentSchedule(loop) && !loop.pendingCompletion && loop.futureIntentId) {
        const candidate = this.require(loop.loopId), controller = new AbortController()
        this.activeDelivery = { loopId: loop.loopId, controller }
        let observation: ContinuousProgressObservation | undefined
        try { observation = await this.observe(candidate, mintObjectId(), now ?? Date.now(), controller.signal) }
        catch (error) { preflightFailure = error; preflightFailed = true }
        finally { if (this.activeDelivery?.controller === controller) this.activeDelivery = undefined }
        const current = this.scheduler.get(loop.loopId)
        if (!this.running || controller.signal.aborted || !current || !isDeepStrictEqual(current, candidate)) continue
        if (!preflightFailed) {
          const decision = decideFutureProgress(observation!, { intentId: candidate.futureIntentId!, occurrenceAt: candidate.nextCheckAt })
          if (decision.kind === 'skip' && ['working', 'stale-working', 'user-input-changed', 'interaction-pending'].includes(decision.reason)) {
            if (candidate.lastDecision !== decision.reason || candidate.lastOutcome !== 'skipped' || candidate.nextCheckAt !== loop.nextCheckAt) {
              this.patch(loop.loopId, { lastDecision: decision.reason, lastOutcome: 'skipped', lastTickAt: checkAt })
              await this.persist(loop.loopId)
            }
            continue
          }
        }
      }
      const claim = this.scheduler.claimTick(loop.loopId, checkAt)
      if (!claim) continue
      // Claim and persist before invoking provider code. A crash or unknown callback result cannot replay a tick.
      try { await this.store.save(this.scheduler.list()) }
      catch (error) {
        this.patch(claim.loop.loopId, { status: 'paused', lastDecision: `Automatic claim persistence is unconfirmed. Manual input remains available. ${error instanceof Error ? error.message : String(error)}` })
        for (const listener of this.listeners) listener(this.require(claim.loop.loopId))
        throw error
      }
      const isCurrent = () => { const current = this.scheduler.get(claim.loop.loopId)
        return this.running && current?.status === 'active' && current.lastTickId === claim.tickId }
      const controller = new AbortController()
      this.activeDelivery = { loopId: claim.loop.loopId, controller }
      let outcome: LoopTickOutcome = 'skipped'
      let pending = claim.loop.pendingCompletion
      let newCheckInClaim = false
      try {
        if (!isCurrent()) continue
        if (claim.loop.taskSource?.kind === 'goal') {
          const source = await this.goalSource(this.require(claim.loop.loopId))
          if (!isCurrent()) continue
          if (source.action !== 'continue') { await this.pauseForSource(claim.loop, source); continue }
        }
        if (pending && claim.loop.lastOutcome === 'unknown') {
          outcome = await this.onTick(claim.loop, pending.operationId, isCurrent, controller.signal)
        } else {
          // Source truth qualifies only a new continuation, never an already-frozen unknown operation.
          if (claim.loop.taskSource && claim.loop.taskSource.kind !== 'goal') {
            const source = await readContinuousProgressTaskSource(claim.loop.taskSource, controller.signal)
            if (!isCurrent()) continue
            this.patch(claim.loop.loopId, { lastDecision: source.reason, ...(source.action === 'stop' ? { status: 'stopped' as const, lastOutcome: 'skipped' as const } : source.action === 'pause' ? { status: 'paused' as const, lastOutcome: 'skipped' as const } : {}) })
            if (source.action !== 'continue') { await this.persist(claim.loop.loopId); continue }
          }
          if (preflightFailed) throw preflightFailure
          const observation = await this.observe(claim.loop, claim.tickId, now ?? Date.now(), controller.signal)
          if (!isCurrent()) continue
          if (claim.loop.taskSource?.kind === 'goal' && observation.session.run.runId !== claim.loop.initialDelivery?.condition.expectedRun.runId) { await this.pauseForSource(claim.loop, { action: 'pause', reason: 'The original executing Run changed. Inspect this Goal before explicitly starting new work; manual input remains available.' }); continue }
          const futureIntent = isAgentSchedule(claim.loop) && claim.loop.futureIntentId ? { intentId: claim.loop.futureIntentId, occurrenceAt: claim.loop.nextCheckAt } : undefined
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
            if (!pending) {
              let prompt = claim.loop.prompt
              let agentMuxNote: string | undefined = AGENTMUX_AGENT_MESSAGING_ENTRY + (claim.loop.checkIn ? '\n\n' + AGENT_SCHEDULE_CHECK_IN_GUIDANCE : '') + (claim.loop.taskSource?.kind === 'goal' ? '\n\n' + goalRoleGuidance({ role: 'executor', goalId: claim.loop.taskSource.goalId, agentSessionId: claim.loop.agentSessionId, runId: observation.session.run.runId, source: { kind: 'goal-native-continuation', operationId: claim.tickId } }) : '')
              if (futureIntent) {
                const original = observation.session.futurePromptIntents?.[futureIntent.intentId]
                if (!original || original.operationId !== claim.loop.creationOperationId || original.message?.userContent !== prompt) {
                  throw new AgentMuxError('The original future-message operation or content is unconfirmed. Inspect the saved arrangement before retrying; manual input remains available.', 'AGENT_FUTURE_INTENT_CHANGED')
                }
                // Each occurrence belongs to the saved message, not the current producer's rules.
                prompt = original.message.userContent
                agentMuxNote = original.message.systemContext
              }
              pending = { id: futureIntent ? `${futureIntent.intentId}@${futureIntent.occurrenceAt}` : decision.completionId, operationId: claim.tickId,
                condition: agentPromptCondition(observation.session), inputByte: observation.inputByte,
                prompt, ...(agentMuxNote === undefined ? {} : { agentMuxNote }), ...(futureIntent ? { futureIntent } : {}) }
            }
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
      const current = this.scheduler.get(claim.loop.loopId)
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
            if (isAgentSchedule(current) && pending?.futureIntent) {
              const nextDue = current.calendar ? nextCalendarOccurrence(current.calendar, checkAt) : current.everyMs !== undefined ? nextIntervalOccurrence(pending.futureIntent.occurrenceAt, checkAt, current.everyMs) : null
              settled.lastOccurrenceAt = pending.futureIntent.occurrenceAt
              settled.nextCheckAt = nextDue ?? current.nextCheckAt
              if (nextDue === null && current.everyMs !== undefined) settled.status = 'paused'
              else if (nextDue === null) settled.status = 'stopped'
              settled.lastDecision = nextDue === null && current.everyMs !== undefined
                ? 'Host accepted the original message; the next occurrence is unrepresentable. Inspect the original arrangement.'
                : 'Host accepted the original future message; a new Agent turn is not yet confirmed.'
            }
          }
          this.scheduler.replace(current.loopId, { ...settled, lastOutcome: outcome, ...(outcome === 'sent' && pending ? { lastCompletionId: pending.id } : {}) })
        }
      }
      await this.persist(claim.loop.loopId)
    }
  }
  private cancelDelivery(loopId: string): void {
    for (const controller of this.activations.get(loopId) ?? []) controller.abort()
    this.initialDeliveries.get(loopId)?.abort()
    if (this.activeDelivery?.loopId === loopId) this.activeDelivery.controller.abort()
  }
  private patch(loopId: string, patch: Partial<ContinuousProgressLoop>): void {
    const loop = this.scheduler.get(loopId)
    if (loop) this.scheduler.replace(loopId, { ...loop, ...patch, ...(isAgentSchedule(loop) && loop.status === 'stopped' ? { status: 'stopped' as const } : {}) })
  }
}
