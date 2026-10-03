import { randomUUID } from 'node:crypto'
import type { AgentPromptCondition } from './agent-prompt-condition.js'
import type { AgentScheduleCalendar } from './agent-schedule.js'

export type ContinuousProgressTarget = {
  hostId: string
  agentSessionId: string
  providerId: string
  workspacePath: string
}

/** Host-selected read-only source locator; Core does not interpret its business lifecycle. */
export type ContinuousProgressTaskSource = { root: string; ownerId: string; readerPath: string }

export type ContinuousProgressLoop = ContinuousProgressTarget & {
  taskSource?: ContinuousProgressTaskSource
  loopId: string
  calendar?: AgentScheduleCalendar
  revision?: number
  creationOperationId?: string
  lastMutation?: { operationId: string; action: 'pause' | 'resume' | 'cancel'; expectedRevision: number }
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
  lastTickId?: string
  lastOutcome?: 'sent' | 'skipped' | 'unknown'
  lastTickAt?: number
  lastDecision?: string
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

  constructor(options: ContinuousProgressSchedulerOptions = {}) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
  }

  restore(records: readonly ContinuousProgressLoop[]): void {
    this.loops = new Map(records.map((record) => [record.loopId, structuredClone(record)]))
  }

  list(): ContinuousProgressLoop[] { return [...this.loops.values()].map((loop) => structuredClone(loop)) }

  create(input: ContinuousProgressTarget & { intervalMs: number; prompt: string; taskSource?: ContinuousProgressTaskSource }): ContinuousProgressLoop {
    if (!input.hostId || !input.agentSessionId || !input.providerId || !input.workspacePath || !input.prompt.trim()) throw new Error('Continuous progress needs an exact target and a nonempty prompt.')
    if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) throw new Error('Loop interval must be positive.')
    if ([...this.loops.values()].some((loop) => !loop.calendar && loop.hostId === input.hostId && loop.agentSessionId === input.agentSessionId && loop.status !== 'stopped')) {
      throw new Error(`A loop already exists for Agent ${input.agentSessionId}.`)
    }
    const now = this.now()
    const loop: ContinuousProgressLoop = { loopId: this.id(), hostId: input.hostId, agentSessionId: input.agentSessionId, providerId: input.providerId, workspacePath: input.workspacePath, intervalMs: input.intervalMs, prompt: input.prompt, nextCheckAt: now + input.intervalMs, status: 'active', ...(input.taskSource ? { taskSource: { ...input.taskSource } } : {}) }
    this.loops.set(loop.loopId, loop)
    return { ...loop }
  }

  requestCheck(loopId: string): ContinuousProgressLoop { return this.update(loopId, { nextCheckAt: this.now() }) }

  createCalendar(input: ContinuousProgressTarget & { calendar: AgentScheduleCalendar; prompt: string; nextDue: number; operationId: string }): ContinuousProgressLoop {
    if (!input.hostId || !input.agentSessionId || !input.providerId || !input.workspacePath || !input.prompt.trim() || !Number.isSafeInteger(input.nextDue)) throw new Error('An exact calendar target, message and next occurrence are required.')
    const loopId = this.id()
    const loop: ContinuousProgressLoop = { loopId, hostId: input.hostId, agentSessionId: input.agentSessionId, providerId: input.providerId, workspacePath: input.workspacePath,
      calendar: structuredClone(input.calendar), revision: 1, creationOperationId: input.operationId, futureIntentId: `${loopId}-1`, intervalMs: 1000, prompt: input.prompt, nextCheckAt: input.nextDue, status: 'active' }
    this.loops.set(loopId, loop)
    return structuredClone(loop)
  }

  pause(loopId: string): ContinuousProgressLoop { return this.update(loopId, { status: 'paused' }) }
  resume(loopId: string): ContinuousProgressLoop {
    const loop = this.require(loopId)
    return this.update(loopId, { status: 'active', nextCheckAt: loop.calendar ? loop.nextCheckAt : this.now() + loop.intervalMs })
  }
  stop(loopId: string): ContinuousProgressLoop { return this.update(loopId, { status: 'stopped' }) }

  due(now = this.now()): ContinuousProgressLoop[] {
    return this.list().filter((loop) => loop.status === 'active' && loop.nextCheckAt <= now)
  }

  /** On restart, recover at most one current due tick per loop; missed periods are never replayed. */
  recover(now = this.now()): Array<{ loop: ContinuousProgressLoop; tickId: string }> {
    return this.list().flatMap((loop) => {
      const claim = this.claimTick(loop.loopId, now)
      return claim ? [claim] : []
    })
  }

  claimTick(loopId: string, now = this.now()): { loop: ContinuousProgressLoop; tickId: string } | null {
    const loop = this.require(loopId)
    if (loop.status !== 'active' || loop.nextCheckAt > now) return null
    const tickId = this.id()
    const nextCheckAt = loop.calendar ? loop.nextCheckAt : now + loop.intervalMs
    const updated = { ...loop, lastTickId: tickId, lastTickAt: now, nextCheckAt }
    this.loops.set(loopId, updated)
    return { loop: { ...updated }, tickId }
  }

  private require(loopId: string): ContinuousProgressLoop {
    const loop = this.loops.get(loopId)
    if (!loop) throw new Error(`Unknown loop: ${loopId}`)
    return loop
  }
  private update(loopId: string, patch: Partial<ContinuousProgressLoop>): ContinuousProgressLoop {
    const updated = { ...this.require(loopId), ...patch }
    this.loops.set(loopId, updated)
    return { ...updated }
  }
}
