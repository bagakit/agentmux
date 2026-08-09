import { randomUUID } from 'node:crypto'

export type ContinuousProgressLoop = {
  loopId: string
  agentSessionId: string
  intervalMs: number
  prompt: string
  nextCheckAt: number
  status: 'active' | 'paused' | 'stopped'
  lastTickId?: string
  lastOutcome?: 'sent' | 'skipped' | 'unknown'
  lastTickAt?: number
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
    this.loops = new Map(records.map((record) => [record.loopId, { ...record }]))
  }

  list(): ContinuousProgressLoop[] { return [...this.loops.values()].map((loop) => ({ ...loop })) }

  create(input: { agentSessionId: string; intervalMs: number; prompt: string }): ContinuousProgressLoop {
    if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) throw new Error('Loop interval must be positive.')
    if ([...this.loops.values()].some((loop) => loop.agentSessionId === input.agentSessionId && loop.status !== 'stopped')) {
      throw new Error(`A loop already exists for Agent ${input.agentSessionId}.`)
    }
    const now = this.now()
    const loop: ContinuousProgressLoop = { loopId: this.id(), agentSessionId: input.agentSessionId, intervalMs: input.intervalMs, prompt: input.prompt, nextCheckAt: now + input.intervalMs, status: 'active' }
    this.loops.set(loop.loopId, loop)
    return { ...loop }
  }

  pause(loopId: string): ContinuousProgressLoop { return this.update(loopId, { status: 'paused' }) }
  resume(loopId: string): ContinuousProgressLoop {
    const loop = this.require(loopId)
    return this.update(loopId, { status: 'active', nextCheckAt: this.now() + loop.intervalMs })
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
    const nextCheckAt = now + loop.intervalMs
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
