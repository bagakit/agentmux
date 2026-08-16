import { ContinuousProgressScheduler, decideContinuousProgress, type ContinuousProgressLoop, type ContinuousProgressObservation } from '@agentmux/core'
import type { ContinuousProgressLoopStore } from './continuous-progress-loop-store.js'

export type LoopTickOutcome = 'sent' | 'skipped' | 'unknown'
export type LoopTickHandler = (loop: ContinuousProgressLoop, operationId: string, isCurrent: () => boolean, signal: AbortSignal) => Promise<LoopTickOutcome>
export type LoopObservationProvider = (loop: ContinuousProgressLoop, tickId: string, now: number) => Promise<ContinuousProgressObservation>

/** Main-process owner: scheduler and durable store stay together; renderer only observes results. */
export class ContinuousProgressLoopManager {
  private readonly scheduler: ContinuousProgressScheduler
  private timer: ReturnType<typeof setInterval> | null = null
  private checkPromise: Promise<void> | null = null
  private running = false
  private activeDelivery: { loopId: string; controller: AbortController } | undefined
  constructor(private readonly store: ContinuousProgressLoopStore, private readonly onTick: LoopTickHandler, now?: () => number, private readonly observe?: LoopObservationProvider) {
    this.scheduler = new ContinuousProgressScheduler({ ...(now ? { now } : {}) })
  }
  async start(): Promise<void> {
    if (this.running) return
    this.scheduler.restore((await this.store.load()).map((loop) => loop.pendingCompletion && loop.status === 'active'
      ? { ...loop, status: 'paused', lastOutcome: 'unknown' } : loop))
    await this.store.save(this.scheduler.list())
    this.running = true
    if (!this.timer) this.timer = setInterval(() => { void this.check().catch(() => {}) }, 1000)
  }
  async stop(): Promise<void> {
    this.running = false
    this.activeDelivery?.controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.checkPromise?.catch(() => {})
    await this.store.save(this.scheduler.list())
  }
  list(): ContinuousProgressLoop[] { return this.scheduler.list() }
  async create(input: { agentSessionId: string; intervalMs: number; prompt: string }): Promise<ContinuousProgressLoop> { const loop = this.scheduler.create(input); await this.store.save(this.scheduler.list()); return loop }
  async pause(loopId: string): Promise<ContinuousProgressLoop> { const loop = this.scheduler.pause(loopId); this.cancelDelivery(loopId); await this.store.save(this.scheduler.list()); return loop }
  async resume(loopId: string): Promise<ContinuousProgressLoop> { const loop = this.scheduler.resume(loopId); await this.store.save(this.scheduler.list()); return loop }
  async stopLoop(loopId: string): Promise<ContinuousProgressLoop> { const loop = this.scheduler.stop(loopId); this.cancelDelivery(loopId); await this.store.save(this.scheduler.list()); return loop }
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
      const isCurrent = () => this.running && this.scheduler.list().some((loop) =>
        loop.loopId === claim.loop.loopId && loop.status === 'active' && loop.lastTickId === claim.tickId)
      const controller = new AbortController()
      this.activeDelivery = { loopId: claim.loop.loopId, controller }
      let outcome: LoopTickOutcome = 'skipped'
      let pending = claim.loop.pendingCompletion
      try {
        if (!isCurrent()) continue
        if (pending && claim.loop.lastOutcome === 'unknown') {
          outcome = await this.onTick(claim.loop, pending.operationId, isCurrent, controller.signal)
        } else if (this.observe) {
          const observation = await this.observe(claim.loop, claim.tickId, now ?? Date.now())
          if (!isCurrent()) continue
          const decision = decideContinuousProgress({ ...observation, ...(claim.loop.lastCompletionId ? { lastCompletionId: claim.loop.lastCompletionId } : {}) })
          if (decision.kind === 'send') {
            // A pending operation is retried only by explicit resume and keeps its identity.
            // If the observed completion changed, the old claim has no authority to send.
            if (!pending) pending = { id: decision.completionId, operationId: claim.tickId }
            if (pending.id === decision.completionId) {
              this.patch(claim.loop.loopId, { pendingCompletion: pending })
              await this.store.save(this.scheduler.list())
              if (!isCurrent()) continue
              outcome = await this.onTick({ ...claim.loop, pendingCompletion: pending }, pending.operationId, isCurrent, controller.signal)
            }
          }
        } else if (isCurrent()) outcome = await this.onTick(claim.loop, claim.tickId, isCurrent, controller.signal)
      } catch { outcome = 'unknown' }
      finally { this.activeDelivery = undefined }
      const current = this.scheduler.list().find((loop) => loop.loopId === claim.loop.loopId)
      if (current) {
        if (outcome === 'unknown') this.patch(current.loopId, {
          ...(current.status === 'active' ? { status: 'paused' } : {}), lastOutcome: 'unknown'
        })
        else {
          const { pendingCompletion: _, ...settled } = current
          this.scheduler.restore(this.scheduler.list().map((loop) => loop.loopId === current.loopId
            ? { ...settled, lastOutcome: outcome, ...(outcome === 'sent' && pending ? { lastCompletionId: pending.id } : {}) } : loop))
        }
      }
      await this.store.save(this.scheduler.list())
    }
  }
  private cancelDelivery(loopId: string): void {
    if (this.activeDelivery?.loopId === loopId) this.activeDelivery.controller.abort()
  }
  private patch(loopId: string, patch: Partial<ContinuousProgressLoop>): void {
    this.scheduler.restore(this.scheduler.list().map((loop) => loop.loopId === loopId ? { ...loop, ...patch } : loop))
  }
}
