import { performAgentContinuity } from './continuity-attempt.js'
import { AgentSessionRunLifecycle } from './lifecycle.js'
import { AgentSessionRecoveryReconciler } from './reconciliation.js'
import { type AgentMuxAgentRestartIdentity, type AgentMuxAgentRestartInput, type AgentMuxAgentRestartInspection } from './restart-contract.js'
import { AgentSessionContinuitySupervisor } from './supervisor.js'
import { AgentSessionContinuityInputs } from './input.js'
import { isDeepStrictEqual } from 'node:util'
import { matchesProviderNativeSessionTarget } from '../agent-native-locator.js'
import { parseBrowserInputContext, parseBrowserInputContextSource } from '../browser-input-context.js'
import { parseAgentInputContextCaptureReference } from '../agent-input-context-capture.js'
import { resolveAgentInputContextCapture, type ResolvedAgentInputContextCapture } from '../agent-input-context-capture-resolve.js'
import { type AgentCapabilityBinding } from '../agent-capability.js'
import { type AgentInputCallContext } from '../agent-input-wait.js'
import { sameRun } from '../agent-session-identity.js'
import { type CtxmuxAdapterRun } from '../ctxmux-run-adapter.js'
import { AgentMuxError } from '../errors.js'
import { type AgentMuxLifecycleReservation } from '../agent-session-store.js'
import { parseAgentContinuityTrigger, type AgentMuxAgentContinuityInput, type AgentMuxAgentContinuityResult } from './continuity-contract.js'
import { parseAgentContinuityControlInput, sameAgentContinuityControlInput, type AgentMuxContinuityControlInput, type AgentMuxContinuityControlReceipt, type AgentMuxContinuityControlResult } from './control-contract.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../types.js'
import type { AgentMuxAgentResumeInput, AgentMuxAgentReopenInput } from './resume-contract.js'
import { safeId } from '../agent-runtime-helpers.js'
import type { AgentSessionRecoveryPorts } from './ports.js'

/** One recovery owner over the original Session/Runtime/Provider authorities. */
export class AgentSessionRecoveryService {
  private readonly continuityInputs: AgentSessionContinuityInputs
  private readonly continuityInputsUnsubscribe: () => void
  private readonly continuitySupervisor: AgentSessionContinuitySupervisor
  private readonly lifetime = new AbortController()
  private readonly lifecycle: AgentSessionRunLifecycle
  private readonly reconciler: AgentSessionRecoveryReconciler
  constructor(private readonly ports: AgentSessionRecoveryPorts) {
    this.continuityInputs = new AgentSessionContinuityInputs({ providers: this.ports.providers.providers,
      read: id => this.ports.sessions.registry.get(id),
      status: async session => { const run = await this.ports.runtime.kernel.status(session.run.runId); this.ports.runtime.assertAgentRun(session, run); return run },
      updateOperation: async (id, operationId, update) => {
        const current = this.ports.sessions.registry.get(id)
        const next = await this.ports.sessions.updateExactAgentSession(id, current.run, value => {
          const original = value.continuityOperations?.[operationId]
          if (!original || original.recoveryDelivery) return value
          const operation = structuredClone(original); update(operation)
          if (isDeepStrictEqual(operation, original)) return value
          return { ...value, updatedAt: Math.max(value.updatedAt + 1, Date.now()),
            continuityOperations: { ...value.continuityOperations, [operationId]: operation },
            ...(value.continuity?.operationId === operationId ? { continuity: operation } : {}) }
        })
        this.ports.events.publishSession(next)
      },
      update: async (id, operationId, update) => {
        const current = this.ports.sessions.registry.get(id)
        const next = await this.ports.sessions.updateExactAgentSession(id, current.run, value => {
          const operation = value.continuityOperations?.[operationId]
          if (!operation?.recoveryDelivery) throw new AgentMuxError('Original continuity input plan is unavailable.', 'CONTINUITY_INPUT_UNCONFIRMED')
          const receipt = structuredClone(operation)
          update(receipt.recoveryDelivery!)
          return { ...value, updatedAt: Math.max(value.updatedAt + 1, Date.now()), continuityOperations: { ...value.continuityOperations, [operationId]: receipt },
            ...(value.continuity?.operationId === operationId ? { continuity: receipt } : {}) }
        })
        this.ports.events.publishSession(next)
      },
      inspect: key => this.ports.input.inspectAgentPromptSubmission(key),
      submit: (input, context) => this.ports.input.submitAgentPrompt(input, context),
      failed: (id, error) => this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: id, code: 'CONTINUITY_INPUT_UNCONFIRMED',
        message: `Recovery input observation is unconfirmed. The original plan and healthy Agent remain available. Inspect or recover the same Session to rejoin. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now() } })
    })
    this.reconciler = new AgentSessionRecoveryReconciler(this.ports, this.continuityInputs, this.lifetime.signal)
    this.continuitySupervisor = new AgentSessionContinuitySupervisor({
      read: async id => { const session = await this.ports.sessions.store.readMetadata(id); return session ? await this.reconciler.observeResumedInterruption(session) : null },
      lifecycle: id => this.ports.sessions.store.readLifecycleReservation(id),
      // This Session came from the original Store's unique Run binding, not this observer's cache.
      status: async session => { const run = await this.ports.runtime.kernel.status(session.run.runId); this.ports.runtime.assertAgentRun(session, run, [session]); return run },
      watch: (run, changed) => this.ports.runtime.kernel.observeLifecycle(run, changed),
      frontend: async session => {
        await this.ports.terminal.ensureTerminalFrontendObservation(session)
        return this.ports.terminal.readFrontendObservation(session.agentSessionId)
      },
      update: async (session, change) => {
        const updated = await this.ports.sessions.updateExactAgentSession(session.agentSessionId, session.run, change)
        this.ports.events.publishSession(updated); return updated
      },
      perform: (input, intentOperationId, inputContextSource, captured) => performAgentContinuity({
        ports: this.ports, supervisor: this.continuitySupervisor, lifecycle: this.lifecycle,
        reconciler: this.reconciler, signal: this.lifetime.signal
      }, input, intentOperationId, inputContextSource, captured),
      failed: (agentSessionId, error, run) => this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId,
        code: 'AGENT_CONTINUITY_OBSERVATION_UNCONFIRMED', message: `Original recovery observation is unconfirmed. The Session, Run and input are retained. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now(), ...(run ? { run } : {}) } })
    })
    this.lifecycle = new AgentSessionRunLifecycle(this.ports, this.continuitySupervisor, this.reconciler, this.lifetime.signal)
    this.continuityInputsUnsubscribe = this.ports.events.publisher.onStatusEvent(event => {
      if (event.type === 'agent-session') this.continuityInputs.observe(this.ports.sessions.registry.get(event.session.agentSessionId))
    })
  }

  async ensureAgentContinuity(
    input: AgentMuxAgentContinuityInput, context?: Pick<AgentInputCallContext, 'inputContextSource' | 'captureReader' | 'requestSignal'>
  ): Promise<AgentMuxAgentContinuityResult> {
    if ('inputContextSource' in input || 'inputContextCaptureProof' in input || input.input &&
        ('inputContextSource' in input.input || 'inputContextCaptureProof' in input.input || 'promptWire' in input.input)) throw new AgentMuxError('Recovery producer facts are supplied only by the original Host.', 'INVALID_INPUT_CONTEXT_CAPTURE')
    if (input.input?.inputContextCapture !== undefined && input.input.inputContext !== undefined) throw new AgentMuxError('A recovery input retains one original capture reference.', 'INVALID_INPUT_CONTEXT_CAPTURE')
    input = { ...input, trigger: input.trigger === undefined ? 'manual' : parseAgentContinuityTrigger(input.trigger), expectedRun: { ...input.expectedRun }, ...(input.input ? { input: { ...input.input,
      ...(input.input.inputContextCapture === undefined ? {} : { inputContextCapture: parseAgentInputContextCaptureReference(input.input.inputContextCapture) }),
      ...(input.input.inputContext === undefined ? {} : { inputContext: parseBrowserInputContext(input.input.inputContext) }) } } : {}) }
    this.ports.connection.requireConnected()
    safeId(input.agentSessionId, 'Agent Session id')
    safeId(input.operationId, 'Agent continuity operation id')
    let captured: ResolvedAgentInputContextCapture | undefined
    if (input.input?.inputContextCapture) {
      const original = input.input
      if (input.trigger !== 'input') throw new AgentMuxError('A capture reference belongs to its original authored input trigger.', 'INVALID_INPUT_CONTEXT_CAPTURE')
      captured = await resolveAgentInputContextCapture({ reference: original.inputContextCapture!, agentSessionId: input.agentSessionId,
        expectedRun: input.expectedRun, operationId: original.submissionId, prompt: original.prompt, ...(original.agentMuxNote === undefined ? {} : { agentMuxNote: original.agentMuxNote }) }, async () => {
          const session = await this.ports.sessions.store.readMetadata(input.agentSessionId)
          const prior = session?.continuityOperations?.[input.operationId]?.launchInput
          return prior?.message ?? await this.ports.input.readCapturedPromptProducer(input.agentSessionId, input.expectedRun, original.submissionId)
        }, context?.captureReader, context?.requestSignal)
    }
    const result = await this.continuitySupervisor.run(input, captured ? 'host-capture' : context?.inputContextSource === undefined ? undefined : parseBrowserInputContextSource(context.inputContextSource), captured)
    if (result.kind === 'resumed' || result.kind === 'reattachable') this.continuityInputs.track(this.ports.sessions.registry.get(input.agentSessionId))
    return result
  }

  async controlAgentContinuity(value: AgentMuxContinuityControlInput,
    context?: Pick<AgentInputCallContext, 'requestSignal' | 'assertCurrent'> & { caller?: { agentSessionId: string; capability: string } }
  ): Promise<AgentMuxContinuityControlResult> {
    const input = parseAgentContinuityControlInput(value)
    context?.requestSignal?.throwIfAborted()
    let author: Readonly<AgentCapabilityBinding> | undefined
    if (context?.caller) {
      const current = await this.ports.sessions.currentStoredAgentSession(context.caller.agentSessionId)
      this.ports.input.resolveMessageAuthor(context.caller.capability, context.caller.agentSessionId, current)
      author = { agentSessionId: current.agentSessionId, workspacePath: current.workspacePath,
        runId: current.run.runId, capabilityHash: current.capabilityHash ?? '' }
    }
    const prior = async (): Promise<AgentMuxContinuityControlResult | null> => {
      const stored = await this.ports.sessions.store.readContinuityControlReceipt(input.agentSessionId, input.operationId)
      if (!stored) return null
      if (!sameAgentContinuityControlInput(stored.receipt.request, input)) throw new AgentMuxError(
        'The original recovery control already has another immutable request.', 'AGENT_CONTINUITY_CONTROL_CONFLICT')
      if (stored.session) {
        let current = stored.session
        try {
          await this.ports.sessions.registry.resolveMetadata(input.agentSessionId, 'local', () => {})
          current = await this.ports.sessions.registry.refresh(input.agentSessionId)
          this.ports.events.publishSession(current)
          this.continuitySupervisor.observe(current)
        } catch (error) {
          this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: input.agentSessionId,
            code: 'AGENT_CONTINUITY_CONTROL_OBSERVATION_UNCONFIRMED',
            message: `The original control receipt is retained; its current observation is unconfirmed. ${error instanceof Error ? error.message : String(error)}`,
            evidence: { source: 'agentmux', run: current.run, observedAt: Date.now() } })
        }
        return { receipt: stored.receipt, state: 'active', session: this.ports.events.projectSession(current) }
      }
      const { agentSessionId, hostId, run, source, observedAt } = stored.retirement
      return { receipt: stored.receipt, state: 'retired', retirement: { agentSessionId, hostId, run, source, observedAt } }
    }
    const original = await prior()
    if (original) return original
    const canonical = await this.ports.sessions.currentStoredAgentSession(input.agentSessionId)
    if (!sameRun(canonical.run, input.expectedRun)) throw new AgentMuxError('The recovery control requires its exact current Run.', 'STALE_AGENT_SESSION')
    const lifecycle = input.action === 'continue' ? await this.ports.sessions.store.readLifecycleReservation(input.agentSessionId) : null
    if (lifecycle?.kind === 'stop' && sameRun(lifecycle.expectedRun, input.expectedRun)) throw new AgentMuxError(
      'The exact original Run has a pending Stop; its recovery cannot be continued.', 'AGENT_CONTINUITY_SUPERSEDED')
    await this.ports.sessions.registry.resolveMetadata(input.agentSessionId, 'local', () => context?.requestSignal?.throwIfAborted())
    await this.ports.sessions.registry.refresh(input.agentSessionId, input.expectedRun)
    await context?.assertCurrent?.()
    context?.requestSignal?.throwIfAborted()
    let receipt: AgentMuxContinuityControlReceipt | undefined
    try {
      // Metadata CAS deliberately does not wait behind an in-flight Start. Its
      // prepare claim consumes cancellation under the same original Store lock.
      const session = await this.ports.sessions.updateExactAgentSession(input.agentSessionId, input.expectedRun, current => {
        if (current.hostId !== 'local') throw new AgentMuxError('The original recovery Host changed.', 'AGENT_CONTINUITY_SUPERSEDED')
        const existing = current.continuityControlReceipts?.[input.operationId] ?? Object.values(current.continuityOperations ?? {})
          .map(operation => operation.supervision?.controlOperations?.[input.operationId]).find(Boolean)
        if (existing) {
          if (!sameAgentContinuityControlInput(existing.request, input)) throw new AgentMuxError(
            'The original recovery control already has another immutable request.', 'AGENT_CONTINUITY_CONTROL_CONFLICT')
          receipt = existing; return current
        }
        const root = current.continuityOperations?.[input.intentOperationId], supervision = root?.supervision
        const waiting = root && supervision?.attemptCount === 0 && !root.newRun && root.kind === 'pending' &&
          !['manual', 'input'].includes(root.trigger) && sameRun(root.previousRun, current.run)
        if (!root || !supervision || root.intentOperationId || !waiting &&
          (!root.nativeTarget || !matchesProviderNativeSessionTarget(root.nativeTarget, current.nativeHandle))) throw new AgentMuxError(
          'The exact original supervised recovery target is unavailable.', 'AGENT_CONTINUITY_SUPERSEDED')
        const active = current.continuityOperations?.[supervision.activeAttemptOperationId]
        if (!active || waiting && active.operationId !== root.operationId || !waiting &&
          (!matchesProviderNativeSessionTarget(root.nativeTarget, active.nativeTarget) ||
          !matchesProviderNativeSessionTarget(active.nativeTarget, current.nativeHandle)) ||
          !(active.newRun ? sameRun(active.newRun, current.run) : sameRun(active.previousRun, current.run))) throw new AgentMuxError(
          'The active recovery attempt no longer names the exact current Run.', 'AGENT_CONTINUITY_SUPERSEDED')
        const next = structuredClone(supervision), observedAt = Date.now()
        let outcome: AgentMuxContinuityControlReceipt['outcome'] = 'unchanged'
        let reason: AgentMuxContinuityControlReceipt['reason'] = supervision.phase === 'settled' ? 'already-settled'
          : supervision.phase === 'cancelled' ? 'already-cancelled' : 'already-active'
        if (input.action === 'cancel' && !['settled', 'cancelled'].includes(supervision.phase)) {
          next.phase = 'cancelled'; next.reason = 'explicit-control'; next.observedAt = observedAt
          if (root.nativeTarget) next.cancellation = { source: 'control', operationId: input.operationId, run: { ...input.expectedRun },
            nativeTarget: structuredClone(root.nativeTarget), observedAt }
          delete next.nextAttemptAt
          outcome = 'cancelled'; reason = 'explicit-cancel'
        } else if (input.action === 'continue') {
          if (['settled', 'cancelled'].includes(supervision.phase) || supervision.cancellation) throw new AgentMuxError(
            'The original recovery intent has already closed; an old control cannot reopen it.', 'AGENT_CONTINUITY_SUPERSEDED')
          if (supervision.phase === 'paused' && (supervision.process?.state !== 'running' || active.frontendReconnect ||
            supervision.reason === 'frontend-retry-budget-exhausted')) {
            const limit = supervision.attemptLimit + input.additionalAttempts
            if (!Number.isSafeInteger(limit)) throw new AgentMuxError('The explicit recovery budget exceeds its exact integer range.', 'INVALID_AGENT_CONTINUITY_CONTROL')
            next.attemptLimit = limit; next.phase = 'observing'; next.reason = 'explicit-control'; next.observedAt = observedAt
            delete next.nextAttemptAt
            outcome = 'continued'; reason = 'explicit-continue'
          }
        }
        receipt = { request: input, outcome, reason, activeAttemptOperationId: supervision.activeAttemptOperationId,
          attemptCount: supervision.attemptCount, attemptLimitBefore: supervision.attemptLimit, attemptLimitAfter: next.attemptLimit,
          phaseAtCommit: next.phase, observedAt }
        next.controlOperations = { ...supervision.controlOperations, [input.operationId]: receipt }
        const updated = { ...root, supervision: next }
        if (waiting && outcome === 'continued') {
          updated.nextActionAt = observedAt
          updated.rechecks = 0
        }
        if (next.phase === 'cancelled') delete updated.nextActionAt
        return { ...current, continuityOperations: { ...current.continuityOperations, [root.operationId]: updated },
          ...(current.continuity?.operationId === root.operationId ? { continuity: updated } : {}), updatedAt: Math.max(current.updatedAt + 1, observedAt) }
      }, undefined, author)
      this.ports.events.publishSession(session)
      this.continuitySupervisor.observe(session)
      if (receipt?.outcome === 'cancelled') {
        const root = session.continuityOperations?.[input.intentOperationId]
        if (root) this.continuitySupervisor.schedule({ agentSessionId: input.agentSessionId, expectedRun: input.expectedRun,
          operationId: root.operationId, trigger: root.trigger }, root)
      }
      return { receipt: structuredClone(receipt!), state: 'active', session: this.ports.events.projectSession(session) }
    } catch (error) {
      const accepted = await prior()
      if (accepted) return accepted
      throw error
    }
  }
  async restartAgent(value: AgentMuxAgentRestartInput): Promise<AgentMuxAgentSession> {
    return this.lifecycle.restartAgent(value)
  }

  async inspectAgentRestart(value: AgentMuxAgentRestartIdentity): Promise<AgentMuxAgentRestartInspection> {
    return this.lifecycle.inspectAgentRestart(value)
  }

  async resumeAgent(input: AgentMuxAgentResumeInput): Promise<AgentMuxAgentSession> {
    return this.lifecycle.resumeAgent(input)
  }

  async reopenAgent(input: AgentMuxAgentReopenInput): Promise<AgentMuxAgentSession> {
    return this.lifecycle.reopenAgent(input)
  }

  async reconcileAgentReopen(input: Pick<AgentMuxAgentReopenInput, 'agentSessionId' | 'expectedRetiredAt' | 'operationId'>): Promise<AgentMuxAgentSession> {
    return this.lifecycle.reconcileAgentReopen(input)
  }

  async completePreparedReopen(
    reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, runs: readonly CtxmuxAdapterRun[]
  ): Promise<AgentMuxStoredAgentSession> {
    return this.lifecycle.completePreparedReopen(reservation, runs)
  }

  async completePreparedResume(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>,
    runs: readonly CtxmuxAdapterRun[]): Promise<AgentMuxStoredAgentSession | null> {
    return this.lifecycle.completePreparedResume(reservation, runs)
  }

  restore(sessions: readonly AgentMuxStoredAgentSession[]): void {
    this.continuityInputs.restore(sessions); this.continuitySupervisor.restore(sessions)
    for (const session of sessions) this.reconciler.observeInitialInput(session)
  }
  observe(session: AgentMuxStoredAgentSession, retry = false): void { this.continuitySupervisor.observe(session, retry); this.reconciler.observeInitialInput(session) }
  wake(id: string): void { this.continuitySupervisor.wake(id) }
  userInput(id: string, runId: string): Promise<void> { return this.continuityInputs.userInput(id, runId) }
  protocolAccepted(id: string, runId: string, operationId: string, range: {startByte: number; endByte: number}): Promise<void> { return this.continuityInputs.protocolAccepted(id, runId, operationId, range) }
  async dispose(): Promise<void> {
    this.lifetime.abort()
    const reconciliation = this.reconciler.dispose()
    await this.continuityInputs.dispose()
    this.continuityInputsUnsubscribe()
    await this.continuitySupervisor.dispose()
    await Promise.allSettled([reconciliation, this.lifecycle.settle()])
  }
}
