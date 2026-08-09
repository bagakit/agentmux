import { ContinuousProgressScheduler, type ContinuousProgressLoop } from '@agentmux/core'
import type { ContinuousProgressLoopStore } from './continuous-progress-loop-store.js'

export type LoopTickOutcome = 'sent' | 'skipped' | 'unknown'
export type LoopTickHandler = (loop: ContinuousProgressLoop, tickId: string) => Promise<LoopTickOutcome>

/** Main-process owner: scheduler and durable store stay together; renderer only observes results. */
export class ContinuousProgressLoopManager {
  private readonly scheduler: ContinuousProgressScheduler
  private timer: ReturnType<typeof setInterval> | null = null
  private checkPromise: Promise<void> | null = null
  private running = false
  constructor(private readonly store: ContinuousProgressLoopStore, private readonly onTick: LoopTickHandler, now?: () => number) {
    this.scheduler = new ContinuousProgressScheduler({ ...(now ? { now } : {}) })
  }
  async start(): Promise<void> {
    if (this.running) return
    this.scheduler.restore(await this.store.load())
    this.running = true
    if (!this.timer) this.timer = setInterval(() => { void this.check().catch(() => {}) }, 1000)
  }
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.checkPromise?.catch(() => {})
    await this.store.save(this.scheduler.list())
  }
  list(): ContinuousProgressLoop[] { return this.scheduler.list() }
  async create(input: { agentSessionId: string; intervalMs: number; prompt: string }): Promise<ContinuousProgressLoop> { const loop = this.scheduler.create(input); await this.store.save(this.scheduler.list()); return loop }
  async pause(loopId: string): Promise<ContinuousProgressLoop> { const loop = this.scheduler.pause(loopId); await this.store.save(this.scheduler.list()); return loop }
  async resume(loopId: string): Promise<ContinuousProgressLoop> { const loop = this.scheduler.resume(loopId); await this.store.save(this.scheduler.list()); return loop }
  async stopLoop(loopId: string): Promise<ContinuousProgressLoop> { const loop = this.scheduler.stop(loopId); await this.store.save(this.scheduler.list()); return loop }
  async check(now?: number): Promise<void> {
    if (this.checkPromise) return await this.checkPromise
    this.checkPromise = this.checkOnce(now).finally(() => { this.checkPromise = null })
    return await this.checkPromise
  }
  private async checkOnce(now?: number): Promise<void> {
    if (!this.running) return
    const claims = this.scheduler.recover(now)
    if (claims.length === 0) return
    // Claim and persist before invoking provider code. A crash or unknown callback result cannot replay a tick.
    await this.store.save(this.scheduler.list())
    for (const claim of claims) {
      let outcome: LoopTickOutcome = 'unknown'
      try { outcome = await this.onTick(claim.loop, claim.tickId) } catch { outcome = 'unknown' }
      const current = this.scheduler.list().find((loop) => loop.loopId === claim.loop.loopId)
      if (current && outcome === 'unknown') {
        this.scheduler.restore(this.scheduler.list().map((loop) => loop.loopId === current.loopId ? { ...loop, status: 'paused', lastOutcome: 'unknown' } : loop))
      } else if (current) {
        this.scheduler.restore(this.scheduler.list().map((loop) => loop.loopId === current.loopId ? { ...loop, lastOutcome: outcome } : loop))
      }
      await this.store.save(this.scheduler.list())
    }
  }
}
