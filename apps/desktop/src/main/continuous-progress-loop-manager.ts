import { ContinuousProgressScheduler, agentPromptCondition, decideContinuousProgress, type ContinuousProgressLoop, type ContinuousProgressTarget, type ContinuousProgressObservation } from '@agentmux/core'
import type { ContinuousProgressLoopStore } from './continuous-progress-loop-store.js'

export type LoopTickOutcome = 'sent' | 'skipped' | 'unknown'
export type LoopTickHandler = (loop: ContinuousProgressLoop, operationId: string, isCurrent: () => boolean, signal: AbortSignal) => Promise<LoopTickOutcome>
export type LoopObservationProvider = (loop: ContinuousProgressLoop, tickId: string, now: number, signal: AbortSignal) => Promise<ContinuousProgressObservation>

/** Main-process owner: scheduler and durable store stay together; renderer only observes results. */
export class ContinuousProgressLoopManager {
  private readonly scheduler: ContinuousProgressScheduler
  private timer: ReturnType<typeof setInterval> | null = null
  private checkPromise: Promise<void> | null = null
  private running = false
  private started: Promise<void> | undefined
  private readonly listeners = new Set<(loop: ContinuousProgressLoop) => void>()
  private activeDelivery: { loopId: string; controller: AbortController } | undefined
  constructor(private readonly store: ContinuousProgressLoopStore, private readonly onTick: LoopTickHandler, now: (() => number) | undefined, private readonly observe: LoopObservationProvider) {
    this.scheduler = new ContinuousProgressScheduler({ ...(now ? { now } : {}) })
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
  subscribe(listener: (loop: ContinuousProgressLoop) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  async create(input: ContinuousProgressTarget & { intervalMs: number; prompt: string }): Promise<ContinuousProgressLoop> {
    await this.start()
    const loop = this.scheduler.create(input)
    await this.persist(loop.loopId)
    return loop
  }
  async pause(loopId: string, reason = 'Paused by you.'): Promise<ContinuousProgressLoop> {
    await this.start()
    this.scheduler.pause(loopId); this.patch(loopId, { lastDecision: reason }); this.cancelDelivery(loopId)
    await this.persist(loopId)
    return this.require(loopId)
  }
  async resume(loopId: string): Promise<ContinuousProgressLoop> {
    await this.start()
    const { lastDecision: _, ...loop } = this.scheduler.resume(loopId)
    this.scheduler.restore(this.list().map(value => value.loopId === loopId ? loop : value))
    await this.persist(loopId)
    return loop
  }
  async stopLoop(loopId: string): Promise<ContinuousProgressLoop> {
    await this.start()
    this.scheduler.stop(loopId); this.cancelDelivery(loopId)
    await this.persist(loopId)
    return this.require(loopId)
  }
  async checkNow(loopId: string): Promise<ContinuousProgressLoop> {
    await this.start()
    if (this.require(loopId).status !== 'active') throw new Error('Resume this loop before checking it.')
    this.scheduler.requestCheck(loopId)
    await this.checkPromise
    await this.check()
    return this.require(loopId)
  }
  pauseTarget(target: Pick<ContinuousProgressTarget, 'hostId' | 'agentSessionId'>, reason: string): Promise<void> {
    const changed = this.list().filter(loop => loop.hostId === target.hostId && loop.agentSessionId === target.agentSessionId && loop.status === 'active')
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
      try {
        if (!isCurrent()) continue
        if (pending && claim.loop.lastOutcome === 'unknown') {
          outcome = await this.onTick(claim.loop, pending.operationId, isCurrent, controller.signal)
        } else {
          const observation = await this.observe(claim.loop, claim.tickId, now ?? Date.now(), controller.signal)
          if (!isCurrent()) continue
          const decision = decideContinuousProgress({ ...observation, ...(claim.loop.lastCompletionId ? { lastCompletionId: claim.loop.lastCompletionId } : {}) })
          if (decision.kind === 'skip') this.patch(claim.loop.loopId, { lastDecision: decision.reason })
          if (decision.kind === 'send') {
            // A pending operation is retried only by explicit resume and keeps its identity.
            // If the observed completion changed, the old claim has no authority to send.
            if (!pending) pending = { id: decision.completionId, operationId: claim.tickId,
              condition: agentPromptCondition(observation.session), inputByte: observation.inputByte }
            if (pending.id === decision.completionId) {
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
          if (outcome === 'sent') delete settled.lastDecision
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
