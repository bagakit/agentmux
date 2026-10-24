import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { matchesProviderNativeSessionTarget } from '../agent-native-locator.js'
import { AgentMuxError } from '../errors.js'
import type { AgentMuxAgentContinuityInput, AgentMuxAgentContinuityResult, AgentMuxContinuityOperation, AgentMuxContinuitySupervision } from './continuity-contract.js'
import { agentContinuityRetryBaseDelay } from './continuity-policy.js'
import type { AgentMuxLifecycleReservation } from '../agent-session-store.js'
import type { AgentMuxRunRef, AgentMuxStoredAgentSession } from '../types.js'
import type { CtxmuxAdapterRun } from '../ctxmux-run-adapter.js'
import type { AgentTerminalFrontend } from '../agent-terminal-frontend.js'

type Dependencies = {
  read(id: string): Promise<AgentMuxStoredAgentSession | null>
  lifecycle(id: string): Promise<AgentMuxLifecycleReservation | null>
  status(session: AgentMuxStoredAgentSession): Promise<CtxmuxAdapterRun>
  frontend?(session: AgentMuxStoredAgentSession): Promise<AgentTerminalFrontend | undefined>
  watch(run: CtxmuxAdapterRun, changed: (error?: AgentMuxError) => void): Promise<() => Promise<void>>
  update(session: AgentMuxStoredAgentSession, change: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession): Promise<AgentMuxStoredAgentSession>
  perform(input: AgentMuxAgentContinuityInput, intentOperationId?: string, inputContextSource?: import('../browser-input-context.js').BrowserInputContextSource, captured?: import('../agent-input-context-capture-resolve.js').ResolvedAgentInputContextCapture): Promise<AgentMuxAgentContinuityResult>
  failed(id: string, error: unknown, run?: AgentMuxRunRef): void
}
const sameRun = (a: AgentMuxRunRef, b: AgentMuxRunRef) => a.runId === b.runId
const terminal = (phase: AgentMuxContinuitySupervision['phase']) => ['settled', 'cancelled', 'paused'].includes(phase)
const operationInput = (op: AgentMuxContinuityOperation): AgentMuxAgentContinuityInput => ({ agentSessionId: op.agentSessionId,
  operationId: op.operationId, expectedRun: op.previousRun, trigger: op.trigger, policy: op.policy,
  ...(op.timingOverride ? { timingOverride: op.timingOverride } : {}), ...(op.trigger === 'input' && op.launchInput ? { input: op.launchInput.input } : {}) })

/** One scheduling and serialization owner; all business facts stay in the original SessionStore. */
export class AgentSessionContinuitySupervisor {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly roots = new Map<string, Set<string>>()
  private readonly queued = new Set<string>()
  private readonly facts = new Map<string, string>()
  private readonly watches = new Map<string, { run: string; close?: () => Promise<void> }>()
  private readonly closing = new Set<Promise<void>>()
  private readonly reobservations = new Set<string>()
  private readonly watchErrors = new Map<string, { run: string; error: AgentMuxError }>()
  private readonly observationController = new AbortController()
  private disposed = false
  constructor(private readonly deps: Dependencies) {}

  /** Dispose cancels only waiting for observations, never an admitted lifecycle or Store write. */
  private async observation<T>(read: () => Promise<T>, releaseLate?: (value: T) => Promise<void>): Promise<T> {
    const signal = this.observationController.signal
    signal.throwIfAborted()
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const abort = () => { if (!settled) { settled = true; reject(signal.reason) } }
      signal.addEventListener('abort', abort, { once: true })
      void read().then(value => {
        signal.removeEventListener('abort', abort)
        if (settled) { void releaseLate?.(value).catch(() => {}); return }
        settled = true; resolve(value)
      }, error => {
        signal.removeEventListener('abort', abort)
        if (!settled) { settled = true; reject(error) }
      })
    })
  }

  async serialize<T>(id: string, perform: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve(), operation = previous.catch(() => {}).then(perform)
    const tail = operation.then(() => {}, () => {}); this.tails.set(id, tail)
    try { return await operation }
    finally { if (this.tails.get(id) === tail) this.tails.delete(id) }
  }

  async run(input: AgentMuxAgentContinuityInput, inputContextSource?: import('../browser-input-context.js').BrowserInputContextSource, captured?: import('../agent-input-context-capture-resolve.js').ResolvedAgentInputContextCapture): Promise<AgentMuxAgentContinuityResult> {
    return await this.serialize(input.agentSessionId, () => this.deps.perform(input, undefined, inputContextSource, captured))
  }

  /** A fresh automatic observer joins the original current intent, never resets its budget or cancellation. */
  retainedAutomaticIntent(session: AgentMuxStoredAgentSession, input: AgentMuxAgentContinuityInput): AgentMuxContinuityOperation | undefined {
    if (!input.trigger || input.input || ['manual', 'input'].includes(input.trigger) || session.continuityOperations?.[input.operationId] ||
      session.hostId !== 'local' || !sameRun(session.run, input.expectedRun)) return
    const pointer = session.continuity, rootId = pointer?.intentOperationId ?? pointer?.operationId
    const root = rootId ? session.continuityOperations?.[rootId] : undefined, supervision = root?.supervision
    const active = supervision ? session.continuityOperations?.[supervision.activeAttemptOperationId] : undefined
    if (!root || root.operationId !== rootId || root.agentSessionId !== session.agentSessionId || !supervision ||
      supervision.phase === 'settled' || root.intentOperationId || !active || active.agentSessionId !== session.agentSessionId ||
      active.operationId !== rootId && active.intentOperationId !== rootId ||
      (active.newRun ? !sameRun(active.newRun, session.run) : !sameRun(active.previousRun, session.run))) return
    // Manual policy parked this intent before any recovery action was admitted.
    // A fresh startup may apply its newly authored automatic policy without
    // resetting a started, cancelled, or otherwise unresolved original action.
    if (input.trigger === 'startup' && input.policy?.activeRecovery !== 'manual' &&
      root.kind === 'pending' && root.reason === 'active-manual' && root.policy.activeRecovery === 'manual' &&
      supervision.phase === 'paused' && supervision.attemptCount === 0 && active.operationId === root.operationId &&
      !root.newRun && !root.frontendReconnect && !root.launchInput) return
    // A new application startup may retry a fully reconciled failed frontend.
    // It never resets this intent's durable counter or abandons an unknown action.
    if (input.trigger === 'startup' && supervision.phase === 'paused' && supervision.reason === 'frontend-retry-budget-exhausted' &&
      (active.kind === 'reattachable' && active.frontendReconnect?.frontendId || active.kind === 'resumed' && active.newRun)) return
    return active
  }

  restore(sessions: readonly AgentMuxStoredAgentSession[]): void {
    for (const session of sessions) {
      this.observe(session, true)
      for (const operation of Object.values(session.continuityOperations ?? {})) {
        if (!operation.action && !operation.supervision && !operation.intentOperationId && operation.nextActionAt !== undefined) this.schedule(operationInput(operation), operation)
      }
    }
  }

  observe(session: AgentMuxStoredAgentSession, retryObservation = false): void {
    if (this.disposed) return
    const roots = Object.values(session.continuityOperations ?? {}).filter(op => !op.action && op.supervision &&
      (!terminal(op.supervision.phase) || retryObservation && op.supervision.phase === 'paused' &&
        ['runtime-unverified', 'provider-unverified', 'exit-outcome-unverified', 'original-operation-unconfirmed'].includes(op.supervision.reason)))
    const live = new Set(roots.map(op => op.operationId))
    for (const rootId of this.roots.get(session.agentSessionId) ?? []) if (!live.has(rootId)) this.clearTimer(session.agentSessionId, rootId)
    if (!roots.length) { this.release(session.agentSessionId); return }
    if (retryObservation) for (const root of roots) if (root.supervision?.phase === 'paused') this.reobservations.add(JSON.stringify([session.agentSessionId, root.operationId]))
    this.roots.set(session.agentSessionId, new Set(roots.map(op => op.operationId)))
    const facts = JSON.stringify([session.run, session.nativeHandle, roots.map(op => [op.operationId, op.kind, op.newRun, op.nextActionAt,
      op.supervision?.phase, op.supervision?.activeAttemptOperationId, op.supervision?.nextAttemptAt, op.supervision?.contextEvidence, op.supervision?.cancellation,
      session.continuityOperations?.[op.supervision!.activeAttemptOperationId]?.kind, session.continuityOperations?.[op.supervision!.activeAttemptOperationId]?.newRun])])
    if (!retryObservation && this.facts.get(session.agentSessionId) === facts) return
    this.facts.set(session.agentSessionId, facts); this.wake(session.agentSessionId)
  }

  schedule(input: AgentMuxAgentContinuityInput, receipt: AgentMuxContinuityOperation): void {
    if (this.disposed || receipt.action) return
    const rootId = receipt.intentOperationId ?? (receipt.supervision ? receipt.operationId : undefined)
    if (rootId) {
      const roots = this.roots.get(input.agentSessionId) ?? new Set<string>(); roots.add(rootId); this.roots.set(input.agentSessionId, roots)
      if (receipt.supervision && terminal(receipt.supervision.phase)) this.wake(input.agentSessionId)
      else if (receipt.nextActionAt !== undefined) this.at(input.agentSessionId, rootId, receipt.nextActionAt, () => this.wake(input.agentSessionId))
      else this.wake(input.agentSessionId)
    } else if (receipt.nextActionAt !== undefined) {
      this.at(input.agentSessionId, receipt.operationId, receipt.nextActionAt, () => {
        void this.serialize(input.agentSessionId, async () => {
          const current = await this.deps.read(input.agentSessionId)
          if (current && sameRun(current.run, input.expectedRun) && current.continuity?.operationId === input.operationId) await this.deps.perform(input)
        }).catch(error => this.deps.failed(input.agentSessionId, error))
      })
    }
  }

  wake(id: string): void {
    if (this.disposed || !this.roots.has(id) || this.queued.has(id)) return
    this.queued.add(id)
    void this.serialize(id, async () => {
      this.queued.delete(id)
      if (this.disposed) return
      for (const rootId of [...(this.roots.get(id) ?? [])]) await this.advance(id, rootId)
    }).catch(error => this.deps.failed(id, error))
  }

  private at(id: string, operationId: string, at: number, execute: () => void): void {
    const key = JSON.stringify([id, operationId]), previous = this.timers.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => { this.timers.delete(key); if (!this.disposed) execute() }, Math.min(0x7fffffff, Math.max(0, at - Date.now())))
    timer.unref?.(); this.timers.set(key, timer)
  }

  private clearTimer(id: string, operationId: string): void {
    const key = JSON.stringify([id, operationId]), timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
  }

  private closeWatch(id: string): void {
    const watch = this.watches.get(id); this.watches.delete(id)
    if (!watch?.close) return
    const closing = watch.close().catch(error => this.deps.failed(id, error)).finally(() => this.closing.delete(closing))
    this.closing.add(closing)
  }

  private release(id: string): void {
    for (const rootId of this.roots.get(id) ?? []) { this.clearTimer(id, rootId); this.reobservations.delete(JSON.stringify([id, rootId])) }
    this.roots.delete(id); this.facts.delete(id); this.watchErrors.delete(id); this.closeWatch(id)
  }

  private async watch(id: string, run: CtxmuxAdapterRun): Promise<void> {
    if (this.disposed || this.watches.get(id)?.run === run.runId) return
    this.closeWatch(id)
    const owner: { run: string; close?: () => Promise<void> } = { run: run.runId }; this.watches.set(id, owner)
    try {
      const close = await this.observation(() => this.deps.watch(run, error => {
        if (this.watches.get(id) !== owner) return
        if (error) { this.watchErrors.set(id, { run: run.runId, error }); this.deps.failed(id, error, { runId: run.runId }) }
        this.closeWatch(id); this.wake(id)
      }), close => close())
      if (this.disposed || this.watches.get(id) !== owner) await close()
      else owner.close = close
    } catch (error) { if (this.watches.get(id) === owner) this.watches.delete(id); throw error }
  }

  private async save(session: AgentMuxStoredAgentSession, root: AgentMuxContinuityOperation, supervision: AgentMuxContinuitySupervision,
    extra?: AgentMuxContinuityOperation, observation?: { rechecks: number; nextActionAt?: number }): Promise<AgentMuxStoredAgentSession> {
    return await this.deps.update(session, current => {
      const original = current.continuityOperations?.[root.operationId]
      if (!original?.supervision || !isDeepStrictEqual(original.supervision, root.supervision)) throw new AgentMuxError('The original recovery intent changed during observation.', 'AGENT_CONTINUITY_SUPERSEDED')
      const updated = { ...original, supervision, ...(observation ?? {}) }
      if (observation && observation.nextActionAt === undefined) delete updated.nextActionAt
      return { ...current, continuityOperations: { ...current.continuityOperations, [root.operationId]: updated, ...(extra ? { [extra.operationId]: extra } : {}) },
        ...(extra ? { continuity: extra } : current.continuity?.operationId === root.operationId ? { continuity: updated } : {}), updatedAt: Math.max(current.updatedAt + 1, Date.now()) }
    })
  }

  private async advance(id: string, rootId: string): Promise<void> {
    const session = await this.deps.read(id), root = session?.continuityOperations?.[rootId], supervision = root?.supervision
    if (this.disposed) return
    if (!session || !root || !supervision) { this.release(id); return }
    if (terminal(supervision.phase)) {
      if (supervision.phase === 'paused' && this.reobservations.delete(JSON.stringify([id, rootId]))) {
        await this.save(session, root, { ...supervision, phase: 'observing', observedAt: Date.now() }, undefined,
          { rechecks: 0, ...(supervision.attemptCount === 0 ? { nextActionAt: Date.now() } : {}) })
        return await this.advance(id, rootId)
      }
      this.clearTimer(id, rootId); this.roots.get(id)?.delete(rootId)
      if (!this.roots.get(id)?.size) this.release(id)
      return
    }
    const active = session.continuityOperations?.[supervision.activeAttemptOperationId]
    const settle = async (phase: AgentMuxContinuitySupervision['phase'], reason: string, process?: AgentMuxContinuitySupervision['process']) => {
      const next = { ...supervision, phase, reason, ...(process ? { process } : {}), observedAt: Date.now() }; delete next.nextAttemptAt
      await this.save(session, root, next)
      if (terminal(phase)) { this.clearTimer(id, rootId); this.roots.get(id)?.delete(rootId); if (!this.roots.get(id)?.size) this.release(id) }
    }
    if (session.hostId !== 'local') { this.release(id); throw new AgentMuxError('The original recovery Host changed; its metadata and Run are retained.', 'AGENT_CONTINUITY_SUPERSEDED') }
    if (active && supervision.attemptCount === 0) {
      if (active.operationId !== rootId || !sameRun(active.previousRun, session.run)) return await settle('paused', 'current-run-changed')
      if (active.nextActionAt === undefined) return await settle('paused', active.reason)
      if (active.nextActionAt !== undefined && active.nextActionAt > Date.now()) {
        this.at(id, rootId, active.nextActionAt, () => this.wake(id)); return
      }
      await this.deps.perform(operationInput(active)); return
    }
    if (!active || !root.nativeTarget || !matchesProviderNativeSessionTarget(root.nativeTarget, session.nativeHandle) ||
      !matchesProviderNativeSessionTarget(root.nativeTarget, active.nativeTarget) || !matchesProviderNativeSessionTarget(active.nativeTarget, session.nativeHandle)) return await settle('paused', 'original-target-changed')
    // A failed lifecycle read is not evidence that Stop is absent.
    const lifecycle = await this.deps.lifecycle(id)
    const activeRun = active.newRun ?? (active.frontendReconnect ? active.previousRun : undefined)
    if (lifecycle?.kind === 'stop' && sameRun(lifecycle.expectedRun, session.run) && activeRun &&
      sameRun(activeRun, session.run)) return await settle('cancelled', 'user-stop')
    const cancellation = supervision.cancellation
    if (cancellation && activeRun && sameRun(cancellation.run, activeRun) &&
      sameRun(cancellation.run, session.run) && matchesProviderNativeSessionTarget(root.nativeTarget, cancellation.nativeTarget) && matchesProviderNativeSessionTarget(cancellation.nativeTarget, session.nativeHandle)) return await settle('cancelled', 'explicit-cancellation')
    if (!activeRun || !sameRun(activeRun, session.run) || active.frontendReconnect && active.kind === 'pending') {
      if (!sameRun(active.previousRun, session.run)) return await settle('paused', 'current-run-changed')
      // Prepared/unknown Start is the same original action. Its own re-entry never starts again.
      if (active.kind === 'starting' || active.reason === 'operation-unconfirmed' || active.kind === 'pending') {
        if (active.kind === 'pending' && active.nextActionAt === undefined && active.rechecks >= root.policy.recheckMaxAttempts) return await settle('paused', 'original-operation-unconfirmed')
        if (active.nextActionAt !== undefined && active.nextActionAt > Date.now()) {
          this.at(id, rootId, active.nextActionAt, () => this.wake(id)); return
        }
        await this.deps.perform(operationInput(active), active.intentOperationId)
        return
      }
      return await settle('paused', 'original-start-unconfirmed')
    }
    if (supervision.process?.state === 'unknown' && root.nextActionAt !== undefined && root.nextActionAt > Date.now()) {
      this.at(id, rootId, root.nextActionAt, () => this.wake(id)); return
    }
    let run: CtxmuxAdapterRun
    try {
      const watchError = this.watchErrors.get(id); this.watchErrors.delete(id)
      if (watchError?.run === session.run.runId) throw watchError.error
      run = await this.observation(() => this.deps.status(session)); if (run.state.type === 'running') await this.watch(id, run); else this.closeWatch(id)
    }
    catch (error) {
      if (this.disposed) return
      const rechecks = root.rechecks + 1
      const nextActionAt = rechecks < root.policy.recheckMaxAttempts ? Math.min(Number.MAX_SAFE_INTEGER, Date.now() + root.policy.recheckIntervalMs) : undefined
      await this.save(session, root, { ...supervision, phase: nextActionAt === undefined ? 'paused' : 'observing', reason: 'runtime-unverified',
        observedAt: Date.now(), process: { run: { ...session.run }, state: 'unknown', observedAt: Date.now() },
        observationError: { code: error instanceof AgentMuxError ? error.code : 'AGENT_CONTINUITY_OBSERVATION_UNCONFIRMED',
          message: error instanceof Error ? error.message : String(error), observedAt: Date.now() } }, undefined,
        { rechecks, ...(nextActionAt === undefined ? {} : { nextActionAt }) })
      if (nextActionAt !== undefined) this.at(id, rootId, nextActionAt, () => this.wake(id))
      return
    }
    if (run.runId !== session.run.runId || run.workspacePath !== session.workspacePath) return await settle('paused', 'current-run-changed')
    const process = { run: { ...session.run }, state: run.state.type, observedAt: Date.now(),
      ...(run.state.type === 'exited' ? { exitCode: run.state.code, exitSignal: run.state.signal } : {}) }
    if (run.state.type === 'running') {
      const frontend = await this.deps.frontend?.(session)
      const exactFrontend = frontend && sameRun(frontend.run, session.run) ? frontend : undefined
      const failedFrontend = exactFrontend?.state === 'detached' && exactFrontend.backendState === 'running' &&
        typeof exactFrontend.exitCode === 'number' && exactFrontend.exitCode !== 0
      if (failedFrontend) {
        if (supervision.attemptCount >= supervision.attemptLimit) return await settle('paused', 'frontend-retry-budget-exhausted', process)
        if (supervision.phase !== 'retry-wait' || supervision.nextAttemptAt === undefined) {
          const base = agentContinuityRetryBaseDelay(root.policy, supervision.attemptCount)
          const nextAttemptAt = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + base)
          await this.save(session, root, { ...supervision, phase: 'retry-wait', reason: 'frontend-nonzero-exit', process, nextAttemptAt, observedAt: Date.now() })
          this.at(id, rootId, nextAttemptAt, () => this.wake(id)); return
        }
        if (supervision.nextAttemptAt > Date.now()) { this.at(id, rootId, supervision.nextAttemptAt, () => this.wake(id)); return }
        const attemptCount = supervision.attemptCount + 1
        const operationId = 'frontend-' + createHash('sha256').update(JSON.stringify([id, rootId, attemptCount])).digest('base64url')
        const attempt: AgentMuxContinuityOperation = { operationId, agentSessionId: id, intentOperationId: rootId, trigger: root.trigger, policy: root.policy,
          previousRun: { ...session.run }, nativeTarget: structuredClone(root.nativeTarget), admittedAt: Date.now(), observedAt: Date.now(), rechecks: 0,
          kind: 'pending', reason: 'runtime-unverified', evidence: { kind: 'run-running', observedAt: Date.now() },
          interruptedWorking: false, recoveryInputs: { reminder: '', continuation: '' } }
        const next = { ...supervision, phase: 'observing' as const, reason: 'frontend-attempt-admitted', activeAttemptOperationId: operationId, attemptCount, observedAt: Date.now() }
        delete next.nextAttemptAt
        await this.save(session, root, next, attempt, { rechecks: 0 })
        if (!this.disposed) await this.deps.perform(operationInput(attempt), rootId)
        return
      }
      if (session.nativeActor?.frontendControl) {
        if (exactFrontend?.state === 'detached' && exactFrontend.exitCode === 0) return await settle('settled', 'frontend-normal-exit', process)
        // Provider attachment is a connection fact, independent of terminal capability.
        // An old ACK without this generation stays untouched; neither fact proves bootstrap.
        // Keep this admitted intent quiet but live for a later exact frontend exit;
        // every further attempt still consumes its original, durable finite budget.
        if (exactFrontend?.state === 'attached' && (!active.frontendReconnect || exactFrontend.frontendId === active.frontendReconnect.frontendId)) {
          if (supervision.phase !== 'observing' || supervision.reason !== 'frontend-attached') await this.save(session, root,
            { ...supervision, phase: 'observing', reason: 'frontend-attached', process, observedAt: Date.now() })
          return
        }
        // Unknown attachment cannot retire the still-running Run's lifecycle reader.
        // Its later authoritative exit must advance this same finite recovery intent.
        if (supervision.phase !== 'observing' || supervision.reason !== 'provider-unverified' ||
          supervision.process?.state !== 'running' || !sameRun(supervision.process.run, session.run)) await this.save(session, root,
          { ...supervision, phase: 'observing', reason: 'provider-unverified', process, observedAt: Date.now() })
        return
      }
      const context = supervision.contextEvidence
      if (context && sameRun(context.run, session.run) && matchesProviderNativeSessionTarget(root.nativeTarget, context.nativeTarget) && matchesProviderNativeSessionTarget(context.nativeTarget, session.nativeHandle)) return await settle('settled', 'context-observed', process)
      if (supervision.phase !== 'observing' || supervision.process?.state !== 'running' || !sameRun(supervision.process.run, session.run)) {
        await this.save(session, root, { ...supervision, phase: 'observing', reason: 'context-unconfirmed', process, observedAt: Date.now() }, undefined, { rechecks: root.rechecks })
      }
      return
    }
    if (run.state.type !== 'exited' || typeof run.state.code !== 'number' || run.state.signal !== null) return await settle('paused', 'exit-outcome-unverified', process)
    if (run.state.code === 0) return await settle('settled', 'normal-exit', process)
    if (!root.policy.resumeAfterExit) return await settle('paused', 'resume-disabled', process)
    if (supervision.attemptCount >= supervision.attemptLimit) return await settle('paused', 'retry-budget-exhausted', process)
    if (supervision.phase !== 'retry-wait' || supervision.nextAttemptAt === undefined) {
      const base = agentContinuityRetryBaseDelay(root.policy, supervision.attemptCount)
      // Deterministic staggering is at most a quarter of the base delay and at most one second.
      const bound = Math.min(1000, Math.floor(base / 4)), digest = createHash('sha256').update(JSON.stringify([id, rootId, supervision.attemptCount + 1])).digest()
      const stagger = bound ? digest.readUInt32BE(0) % (bound + 1) : 0
      const nextAttemptAt = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + base + stagger)
      await this.save(session, root, { ...supervision, phase: 'retry-wait', reason: 'confirmed-nonzero-exit', process, nextAttemptAt, observedAt: Date.now() })
      this.at(id, rootId, nextAttemptAt, () => this.wake(id)); return
    }
    if (supervision.nextAttemptAt > Date.now()) { this.at(id, rootId, supervision.nextAttemptAt, () => this.wake(id)); return }
    const attemptCount = supervision.attemptCount + 1
    const operationId = 'recovery-' + createHash('sha256').update(JSON.stringify([id, rootId, attemptCount])).digest('base64url')
    const attempt: AgentMuxContinuityOperation = { operationId, agentSessionId: id, intentOperationId: rootId, trigger: root.trigger, policy: root.policy,
      previousRun: { ...session.run }, nativeTarget: structuredClone(root.nativeTarget), admittedAt: Date.now(), observedAt: Date.now(), rechecks: 0,
      kind: 'pending', reason: 'runtime-unverified', evidence: { kind: 'run-ended', state: 'exited', observedAt: Date.now() },
      interruptedWorking: false, recoveryInputs: { reminder: '', continuation: '' } }
    const next = { ...supervision, phase: 'observing' as const, reason: 'attempt-admitted', activeAttemptOperationId: operationId, attemptCount, observedAt: Date.now() }
    delete next.nextAttemptAt
    await this.save(session, root, next, attempt, { rechecks: 0 })
    if (this.disposed) return
    await this.deps.perform(operationInput(attempt), rootId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.observationController.abort(new AgentMuxError('Original recovery observation owner was disposed; lifecycle and input receipts are retained.', 'AGENT_CONTINUITY_OBSERVATION_CANCELLED'))
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear(); this.roots.clear(); this.facts.clear(); this.reobservations.clear(); this.watchErrors.clear()
    for (const id of this.watches.keys()) this.closeWatch(id)
    await Promise.allSettled([...this.tails.values()])
    await Promise.allSettled([...this.closing])
  }
}
