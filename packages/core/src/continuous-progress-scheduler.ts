import { mintObjectId } from './object-id.js'
import { AgentMuxError } from './errors.js'
import type { AgentPromptCondition } from './agent-prompt-condition.js'
import { parseAgentScheduleTiming, type AgentScheduleCalendar, type AgentScheduleCheckInPolicy, type AgentScheduleCheckInState, type AgentScheduleTiming } from './agent-schedule.js'

export type ContinuousProgressTarget = {
  hostId: string
  agentSessionId: string
  providerId: string
  workspacePath: string
}

/** Host-selected read-only source locator; Core does not interpret its business lifecycle. */
export type ContinuousProgressGoalSource = { kind: 'goal'; goalId: string; alignmentRevision: number }
export type ContinuousProgressTaskSource = { kind?: 'feature'; root: string; ownerId: string; readerPath: string } | ContinuousProgressGoalSource

export type ContinuousProgressLoop = ContinuousProgressTarget & {
  taskSource?: ContinuousProgressTaskSource
  loopId: string
  calendar?: AgentScheduleCalendar
  afterMs?: number
  everyMs?: number
  checkIn?: AgentScheduleCheckInPolicy
  checkInState?: AgentScheduleCheckInState
  revision?: number
  creationOperationId?: string
  lastMutation?: { operationId: string; action: 'pause' | 'resume' | 'cancel' | 'stop' | 'check'; expectedRevision: number } | { operationId: string; action: 'update'; expectedRevision: number; requestDigest: string }
  /** Initial input is saved in this same loop before the original input queue may send. */
  initialDelivery?: { operationId: string; prompt: string; condition: AgentPromptCondition; state: 'prepared' | 'unknown' | 'confirmed'; startedAt: number }
  futureIntentId?: string
  lastOccurrenceAt?: number
  intervalMs: number
  prompt: string
  nextCheckAt: number
  status: 'active' | 'paused' | 'stopped'
  pendingCompletion?: {
    id: string
    operationId: string
    condition?: AgentPromptCondition
    inputByte?: number
    /** First-claim content, kept with the operation through unknown delivery and cold resume. */
    prompt?: string
    agentMuxNote?: string
    futureIntent?: { intentId: string; occurrenceAt: number }
  }
  lastCompletionId?: string
  /** Last claimed tick; durability may be unconfirmed. Read-only checks create no claim. */
  lastTickId?: string
  lastOutcome?: 'sent' | 'skipped' | 'unknown'
  /** Last recorded check; later identical busy observations need not rewrite it. */
  lastTickAt?: number
  lastDecision?: string
}

/** Distinguish saved future messages from completion-driven Goal/interval loops. */
export function isAgentSchedule(loop: Pick<ContinuousProgressLoop, 'calendar' | 'afterMs' | 'everyMs'>): boolean {
  return loop.calendar !== undefined || loop.afterMs !== undefined || loop.everyMs !== undefined
}

export type ContinuousProgressSchedulerOptions = {
  now?: () => number
  id?: () => string
}

/** Provider-neutral durable loop clock. Hosts persist returned loop records and perform observations. */
export class ContinuousProgressScheduler {
  private readonly now: () => number
  private readonly id: () => string
  private loops = new Map<string, ContinuousProgressLoop>()
  private readonly targetLoops = new Map<string, Map<string, number>>()
  private nextOrdinal = 0

  constructor(options: ContinuousProgressSchedulerOptions = {}) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? mintObjectId
  }

  restore(records: readonly ContinuousProgressLoop[]): void {
    this.loops = new Map(records.map((record) => [record.loopId, structuredClone(record)]))
    this.targetLoops.clear()
    this.nextOrdinal = 0
    for (const loop of this.loops.values()) this.indexLoop(loop, this.nextOrdinal++)
  }

  list(target?: Readonly<Partial<ContinuousProgressTarget>>): ContinuousProgressLoop[] {
    // The ordinal preserves the original Map order when replace moves an older
    // loop to a target which already owns newer records. Only IDs are indexed.
    const indexed = target?.hostId !== undefined && target.agentSessionId !== undefined
      ? this.targetLoops.get(this.targetKey({ hostId: target.hostId, agentSessionId: target.agentSessionId })) : undefined
    const records = target?.hostId !== undefined && target.agentSessionId !== undefined
      ? [...(indexed ?? [])].sort((a, b) => a[1] - b[1]).map(([id]) => this.loops.get(id)!)
      : [...this.loops.values()]
    const selected = target ? records.filter(loop =>
      (['hostId', 'agentSessionId', 'providerId', 'workspacePath'] as const).every(key => target[key] === undefined || loop[key] === target[key])) : records
    return selected.map(loop => structuredClone(loop))
  }

  get(loopId: string): ContinuousProgressLoop | undefined {
    const loop = this.loops.get(loopId)
    return loop ? structuredClone(loop) : undefined
  }

  replace(loopId: string, loop: ContinuousProgressLoop): void {
    if (!this.loops.has(loopId) || loop.loopId !== loopId) throw new Error(`Unknown loop: ${loopId}`)
    this.setLoop(structuredClone(loop))
  }

  private targetKey(target: Pick<ContinuousProgressTarget, 'hostId' | 'agentSessionId'>): string {
    return JSON.stringify([target.hostId, target.agentSessionId])
  }

  private indexLoop(loop: ContinuousProgressLoop, ordinal: number): void {
    const key = this.targetKey(loop), entries = this.targetLoops.get(key) ?? new Map<string, number>()
    entries.set(loop.loopId, ordinal)
    this.targetLoops.set(key, entries)
  }

  private setLoop(loop: ContinuousProgressLoop): void {
    const previous = this.loops.get(loop.loopId)
    const oldKey = previous && this.targetKey(previous)
    const oldEntries = oldKey === undefined ? undefined : this.targetLoops.get(oldKey)
    const ordinal = oldEntries?.get(loop.loopId) ?? this.nextOrdinal++
    if (oldKey !== undefined && oldKey !== this.targetKey(loop)) {
      oldEntries!.delete(loop.loopId)
      if (!oldEntries!.size) this.targetLoops.delete(oldKey)
    }
    this.loops.set(loop.loopId, loop)
    this.indexLoop(loop, ordinal)
  }

  create(input: ContinuousProgressTarget & { intervalMs: number; prompt: string; taskSource?: ContinuousProgressTaskSource; operationId?: string; initialDelivery?: ContinuousProgressLoop['initialDelivery'] }): ContinuousProgressLoop {
    if (!input.hostId || !input.agentSessionId || !input.providerId || !input.workspacePath || !input.prompt.trim()) throw new Error('Continuous progress needs an exact target and a nonempty prompt.')
    if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) throw new Error('Loop interval must be positive.')
    if (this.list({ hostId: input.hostId, agentSessionId: input.agentSessionId }).some(loop => !isAgentSchedule(loop) && loop.status !== 'stopped')) {
      throw new Error(`A loop already exists for Agent ${input.agentSessionId}.`)
    }
    const now = this.now()
    const loop: ContinuousProgressLoop = { loopId: this.id(), hostId: input.hostId, agentSessionId: input.agentSessionId, providerId: input.providerId, workspacePath: input.workspacePath, intervalMs: input.intervalMs, prompt: input.prompt, nextCheckAt: now + input.intervalMs, status: input.initialDelivery ? 'paused' : 'active', ...(input.taskSource ? { taskSource: { ...input.taskSource } } : {}), ...(input.operationId ? { creationOperationId: input.operationId, revision: 1 } : {}), ...(input.initialDelivery ? { initialDelivery: structuredClone(input.initialDelivery) } : {}) }
    this.setLoop(loop)
    return { ...loop }
  }

  requestCheck(loopId: string): ContinuousProgressLoop { return this.update(loopId, { nextCheckAt: this.now() }) }

  createSchedule(input: ContinuousProgressTarget & AgentScheduleTiming & { prompt: string; nextDue: number; operationId: string }): ContinuousProgressLoop {
    if (!input.hostId || !input.agentSessionId || !input.providerId || !input.workspacePath || !input.prompt.trim() || (!Number.isSafeInteger(input.nextDue) || input.nextDue < 0)) throw new Error('An exact schedule target, message and next occurrence are required.')
    const timing = parseAgentScheduleTiming({ calendar: input.calendar, afterMs: input.afterMs, everyMs: input.everyMs, checkIn: input.checkIn })
    const loopId = this.id()
    const loop: ContinuousProgressLoop = { loopId, hostId: input.hostId, agentSessionId: input.agentSessionId, providerId: input.providerId, workspacePath: input.workspacePath,
      ...timing, revision: 1, creationOperationId: input.operationId, futureIntentId: `${loopId}-1`, intervalMs: 1000, prompt: input.prompt, nextCheckAt: input.nextDue, status: 'active' }
    this.setLoop(loop)
    return structuredClone(loop)
  }

  pause(loopId: string): ContinuousProgressLoop {
    const loop = this.require(loopId)
    if (isAgentSchedule(loop) && loop.status === 'stopped') throw new AgentMuxError('An ended arrangement cannot pause or resume. Save a new arrangement explicitly.', 'SCHEDULE_CANCELLED')
    return this.update(loopId, { status: 'paused' })
  }
  resume(loopId: string): ContinuousProgressLoop {
    const loop = this.require(loopId)
    if (isAgentSchedule(loop) && loop.status === 'stopped') throw new AgentMuxError('An ended arrangement cannot pause or resume. Save a new arrangement explicitly.', 'SCHEDULE_CANCELLED')
    return this.update(loopId, { status: 'active', nextCheckAt: isAgentSchedule(loop) ? loop.nextCheckAt : this.now() + loop.intervalMs })
  }
  stop(loopId: string): ContinuousProgressLoop { return this.update(loopId, { status: 'stopped' }) }

  due(now = this.now(), onlyLoopId?: string): ContinuousProgressLoop[] {
    const selected = onlyLoopId === undefined ? this.loops.values() : [this.loops.get(onlyLoopId)]
    return [...selected]
      .filter((loop): loop is ContinuousProgressLoop => !!loop && loop.status === 'active' && loop.nextCheckAt <= now)
      .map((loop) => structuredClone(loop))
  }

  /** On restart, recover at most one current due tick per loop; missed periods are never replayed. */
  recover(now = this.now()): Array<{ loop: ContinuousProgressLoop; tickId: string }> {
    return [...this.loops.keys()].flatMap((loopId) => {
      const claim = this.claimTick(loopId, now)
      return claim ? [claim] : []
    })
  }

  claimTick(loopId: string, now = this.now()): { loop: ContinuousProgressLoop; tickId: string } | null {
    const loop = this.require(loopId)
    if (loop.status !== 'active' || loop.nextCheckAt > now) return null
    const tickId = this.id()
    const nextCheckAt = isAgentSchedule(loop) ? loop.nextCheckAt : now + loop.intervalMs
    const updated = { ...loop, lastTickId: tickId, lastTickAt: now, nextCheckAt }
    this.setLoop(updated)
    return { loop: { ...updated }, tickId }
  }

  private require(loopId: string): ContinuousProgressLoop {
    const loop = this.loops.get(loopId)
    if (!loop) throw new Error(`Unknown loop: ${loopId}`)
    return loop
  }
  private update(loopId: string, patch: Partial<ContinuousProgressLoop>): ContinuousProgressLoop {
    const updated = { ...this.require(loopId), ...patch }
    this.setLoop(updated)
    return { ...updated }
  }
}

/** Validate Host-owned Goal loop facts at the public receipt boundary; no Goal lifecycle is interpreted here. */
export function parseGoalContinuationLoop(value: unknown): ContinuousProgressLoop {
  const loop = value as ContinuousProgressLoop | null
  const validId = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\0\r\n]/u.test(v)
  if (!loop || typeof loop !== 'object' || Array.isArray(loop) || (Object.hasOwn(loop, 'calendar') || Object.hasOwn(loop, 'afterMs') || Object.hasOwn(loop, 'everyMs')) ||
      ![loop.loopId, loop.hostId, loop.agentSessionId, loop.providerId, loop.workspacePath, loop.creationOperationId].every(validId) ||
      !Number.isSafeInteger(loop.revision) || loop.revision! < 1 || !Number.isFinite(loop.intervalMs) || loop.intervalMs <= 0 ||
      !Number.isFinite(loop.nextCheckAt) || typeof loop.prompt !== 'string' || !loop.prompt.trim() || !['active', 'paused', 'stopped'].includes(loop.status) ||
      loop.taskSource?.kind !== 'goal' || !validId(loop.taskSource.goalId) || !Number.isSafeInteger(loop.taskSource.alignmentRevision) || loop.taskSource.alignmentRevision < 1 ||
      !loop.initialDelivery || loop.initialDelivery.operationId !== loop.creationOperationId || typeof loop.initialDelivery.prompt !== 'string' || !loop.initialDelivery.prompt.trim() ||
      !Number.isFinite(loop.initialDelivery.startedAt) || !['prepared', 'unknown', 'confirmed'].includes(loop.initialDelivery.state) ||
      !validId(loop.initialDelivery.condition?.expectedRun?.runId) || !Object.hasOwn(loop.initialDelivery.condition, 'afterSubmissionId') ||
      !(loop.initialDelivery.condition.afterSubmissionId === null || validId(loop.initialDelivery.condition.afterSubmissionId))) throw new Error('Goal continuation identity or original initial receipt is unconfirmed.')
  if (loop.pendingCompletion && (!validId(loop.pendingCompletion.id) || !validId(loop.pendingCompletion.operationId) ||
      typeof loop.pendingCompletion.prompt !== 'string' || !validId(loop.pendingCompletion.condition?.expectedRun?.runId) ||
      !Object.hasOwn(loop.pendingCompletion.condition, 'afterSubmissionId') || !(loop.pendingCompletion.condition.afterSubmissionId === null || validId(loop.pendingCompletion.condition.afterSubmissionId)))) throw new Error('Original continuation transaction is unconfirmed.')
  if (loop.lastMutation && (!validId(loop.lastMutation.operationId) || !['pause', 'resume', 'stop', 'check'].includes(loop.lastMutation.action) || !Number.isSafeInteger(loop.lastMutation.expectedRevision))) throw new Error('Original continuation mutation is unconfirmed.')
  return structuredClone(loop)
}
