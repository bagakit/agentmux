import { ContinuousProgressScheduler, type ContinuousProgressLoop } from '@agentmux/core'
import type { ContinuousProgressLoopStore } from './continuous-progress-loop-store.js'

export type LoopTickHandler = (loop: ContinuousProgressLoop, tickId: string) => Promise<'sent' | 'skipped' | 'unknown'>

/** Main-process owner: scheduler and durable store stay together; renderer only observes results. */
export class ContinuousProgressLoopManager {
  private readonly scheduler: ContinuousProgressScheduler
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  constructor(private readonly store: ContinuousProgressLoopStore, private readonly onTick: LoopTickHandler, now?: () => number) {
    this.scheduler = new ContinuousProgressScheduler({ ...(now ? { now } : {}) })
  }
  async start(): Promise<void> {
    this.scheduler.restore(await this.store.load())
    this.running = true
    if (!this.timer) this.timer = setInterval(() => void this.check(), 1000)
  }
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.store.save(this.scheduler.list())
  }
  list(): ContinuousProgressLoop[] { return this.scheduler.list() }
  async create(input: { agentSessionId: string; intervalMs: number; prompt: string }): Promise<ContinuousProgressLoop> { const loop = this.scheduler.create(input); await this.store.save(this.scheduler.list()); return loop }
  async pause(loopId: string): Promise<ContinuousProgressLoop> { const loop = this.scheduler.pause(loopId); await this.store.save(this.scheduler.list()); return loop }
  async resume(loopId: string): Promise<ContinuousProgressLoop> { const loop = this.scheduler.resume(loopId); await this.store.save(this.scheduler.list()); return loop }
  async stopLoop(loopId: string): Promise<ContinuousProgressLoop> { const loop = this.scheduler.stop(loopId); await this.store.save(this.scheduler.list()); return loop }
  async check(now?: number): Promise<void> {
    if (!this.running) return
    const claims = this.scheduler.recover(now)
    for (const claim of claims) {
      let result: 'sent' | 'skipped' | 'unknown' = 'unknown'
      try { result = await this.onTick(claim.loop, claim.tickId) } catch { result = 'unknown' }
      // claim is durable before handler execution; unknown results are never retried in this cycle.
      if (result === 'sent' || result === 'skipped' || result === 'unknown') await this.store.save(this.scheduler.list())
    }
  }
}
