import { assertAgentPromptSize } from '../agent-runtime-helpers.js'
import { parseTerminalFrontendObservation, type AgentTerminalFrontendObservation, type AgentTerminalFrontendRecoveryRequest } from '../agent-terminal-frontend.js'
import { observePromptInput } from '../prompt-submission.js'
import { parseAgentRestartInput, type AgentMuxAgentRestartIdentity, type AgentMuxAgentRestartInput, type AgentMuxAgentRestartInspection } from './restart.js'
import { AgentSessionContinuitySupervisor } from './supervisor.js'
import { inspectAgentSessionInterruption } from './interruption.js'
import { observeResumedTurnInterruption } from './resumed-interruption.js'
import { AgentSessionContinuityInputs, createContinuityInputDelivery, prepareContinuityLaunchInput, bindContinuityLaunchInput } from './input.js'
import { executorUnavailableError } from '../executable-probe.js'
import { unconfirmedExecutableObservation } from '../executable-observation.js'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { matchesProviderNativeSessionTarget } from '../agent-native-locator.js'
import { continuityExecutorEntries, readContinuityExecutor, unconfirmedContinuityExecutor, type AgentContinuityExecutor } from './executor.js'
import { splitLaunchPromptByDelivery } from '../agent-provider.js'
import { composeAgentPrompt, composeAgentResumePrompt } from '../agent-outbound-message.js'
import { parseBrowserInputContext, parseBrowserInputContextSource } from '../browser-input-context.js'
import { parseAgentInputContextCaptureReference } from '../agent-input-context-capture.js'
import { resolveAgentInputContextCapture, type ResolvedAgentInputContextCapture } from '../agent-input-context-capture-resolve.js'
import { hashAgentCapability, issueAgentCapability, type AgentCapabilityBinding } from '../agent-capability.js'
import { type AgentInputCallContext } from '../agent-input-wait.js'
import { AGENT_TERMINAL_HANDSHAKE_FAILED } from '../agent-terminal-handshake-outcome.js'
import { agentPromptNotApplied } from '../agent-prompt-condition.js'
import { sameRun } from '../agent-session-identity.js'
import { type CtxmuxAdapterRun } from '../ctxmux-run-adapter.js'
import { AgentMuxError } from '../errors.js'
import { agentLifecycleOperationIdentity, type AgentMuxLifecycleReservation } from '../agent-session-store.js'
import { decideAgentSessionContinuity, agentContinuityAdmission, normalizeAgentContinuityPolicy, DEFAULT_AGENT_CONTINUITY_CONTINUATION, type AgentMuxContinuityOperation, type AgentMuxAgentContinuityInput, type AgentMuxAgentContinuityResult } from './continuity.js'
import { parseAgentContinuityControlInput, sameAgentContinuityControlInput, type AgentMuxContinuityControlInput, type AgentMuxContinuityControlReceipt, type AgentMuxContinuityControlResult } from './control.js'
import { type AgentHookBinding } from '../hook-server.js'
import type { AgentCapabilitySnapshot, AgentMuxAgentSession, AgentPromptMessageContent, AgentMuxRun, AgentMuxRunRef, AgentMuxStoredAgentSession } from '../types.js'
import { agentCreationIntentDigest } from '../agent-creation-authority.js'
import type { AgentMuxAgentResumeInput, AgentMuxAgentReopenInput, AgentMuxAgentResumeOperationInput } from './contracts.js'
import { runRef, safeId, hookBindingIdentity, terminalHandshakeOperationIdentity, terminalInitialPromptReadinessIdentity, terminalEnvironment } from '../agent-runtime-helpers.js'
import type { AgentSessionRecoveryPorts } from './ports.js'

function rolledBackResumeFailure(session: AgentMuxStoredAgentSession | undefined, operationId: string): AgentMuxError | null {
  const original = session?.continuityOperations?.[operationId]
  const failedRun = original?.newRun
  if (!session || !original || original.supervision || original.intentOperationId || original.action ||
      original.kind !== 'unavailable' || original.reason !== 'process-exited' ||
      original.errorCode !== AGENT_TERMINAL_HANDSHAKE_FAILED || !failedRun ||
      original.nativeTarget?.kind !== 'provider' || original.nativeTarget.providerId !== session.providerId ||
      !sameRun(original.previousRun, session.run) && !session.retiredRuns.some(run => sameRun(run, original.previousRun)) ||
      !session.retiredRuns.some(run => sameRun(run, failedRun)) ||
      sameRun(original.previousRun, failedRun)) return null
  return new AgentMuxError(original.error ?? 'The original resume Run exited during startup.', original.errorCode)
}

/** One recovery owner over the original Session/Runtime/Provider authorities. */
export class AgentSessionRecoveryService {
  private readonly continuityInputs: AgentSessionContinuityInputs
  private readonly continuityInputsUnsubscribe: () => void
  private readonly executingRestarts = new Set<string>()
  private readonly restartSettlements = new Map<string, Promise<void>>()
  private readonly executingReopens = new Set<string>()
  private readonly reopenSettlements = new Map<string, Promise<void>>()
  private readonly continuitySupervisor: AgentSessionContinuitySupervisor
  private readonly resumedInterruptionReads = new Map<string, Promise<AgentMuxStoredAgentSession>>()
  private readonly providerReads = new Set<AbortController>()
  private readonly initialInputContinuations = new Map<string, Promise<void>>()
  private reopensDisposed = false
  constructor(private readonly ports: AgentSessionRecoveryPorts) {
    this.continuitySupervisor = new AgentSessionContinuitySupervisor({
      read: async id => { const session = await this.ports.sessions.store.readMetadata(id); return session ? await this.observeResumedInterruption(session) : null },
      lifecycle: id => this.ports.sessions.store.readLifecycleReservation(id),
      // This Session came from the original Store's unique Run binding, not this observer's cache.
      status: async session => { const run = await this.ports.runtime.kernel.status(session.run.runId); this.ports.runtime.assertAgentRun(session, run, [session]); return run },
      watch: (run, changed) => this.ports.runtime.kernel.observeLifecycle(run, changed),
      frontend: async session => {
        await this.ports.terminal.ensureTerminalFrontendObservation(session)
        return this.ports.terminal.terminalFrontendWatches.get(session.agentSessionId)?.frontend
      },
      update: async (session, change) => {
        const updated = await this.ports.sessions.updateExactAgentSession(session.agentSessionId, session.run, change)
        this.ports.events.publishSession(updated); return updated
      },
      perform: (input, intentOperationId, inputContextSource, captured) => this.performAgentContinuity(input, intentOperationId, inputContextSource, captured),
      failed: (agentSessionId, error, run) => this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId,
        code: 'AGENT_CONTINUITY_OBSERVATION_UNCONFIRMED', message: `Original recovery observation is unconfirmed. The Session, Run and input are retained. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now(), ...(run ? { run } : {}) } })
    })

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
    input = { ...input, trigger: input.trigger ?? 'manual', expectedRun: { ...input.expectedRun }, ...(input.input ? { input: { ...input.input,
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

  // Per-Agent-Session serialization of continuity attempts. NOT what bounds new Runs to one — the
  // store's `reserveLifecycle` is an atomic check-and-set, so a concurrent loser fails its
  // reservation before ever reaching `kernel.start` even with this tail removed (measured).
  // What the tail buys is the loser's CLASSIFICATION: serialized behind the winner, its expectedRun
  // fence sees the Run already replaced and reports `session-run-changed` with `currentRun` pointing
  // at the real new Run. Run them concurrently and the loser's fence passes on the stale Run, then
  // trips the reservation and surfaces a bare `lifecycle-busy` carrying an outdated `currentRun` —
  // a worse answer to "why did my recovery not happen". Guarded by the concurrency tests in
  // agent-session-continuity.test.ts; deleting this makes them red on the reason, not on the count.
  private async serializeAgentContinuity<T>(agentSessionId: string, execute: () => Promise<T>): Promise<T> {
    return await this.continuitySupervisor.serialize(agentSessionId, execute)
  }

  async restartAgent(value: AgentMuxAgentRestartInput): Promise<AgentMuxAgentSession> {
    const input = parseAgentRestartInput(value)
    if (this.reopensDisposed) throw new AgentMuxError('This restart owner has been disposed. Use the current Core owner and the original operation.', 'AGENT_RESTART_OWNER_DISPOSED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    this.ports.connection.requireConnected()
    const operation = agentLifecycleOperationIdentity('restart', input.agentSessionId, input.operationId)
    let digest = agentCreationIntentDigest({ ...input, action: 'restart' })
    const identityOnly = !['args', 'env', 'commandOverride', 'cols', 'rows'].some(key => Object.hasOwn(input, key))
    if (this.executingRestarts.has(operation)) throw new AgentMuxError('The original restart is still executing. Inspect that operation.',
      'AGENT_RESTART_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
    this.executingRestarts.add(operation)
    let settle!: () => void
    this.restartSettlements.set(operation, new Promise<void>(resolve => { settle = resolve }))
    try {
      await this.ports.sessions.resolveRawAgentSession(input.agentSessionId)
      const canonical = await this.ports.sessions.registry.refresh(input.agentSessionId)
      const prior = canonical.continuityOperations?.[input.operationId]
      if (identityOnly && prior?.action === 'restart' && prior.requestDigest) digest = prior.requestDigest
      if (prior) {
        if (prior.action !== 'restart' || prior.requestDigest !== digest || !sameRun(prior.previousRun, input.expectedRun)) {
          throw new AgentMuxError('The original restart request changed. Keep its operation and original Run.', 'AGENT_RESTART_CONFLICT')
        }
        if (prior.newRun && prior.kind === 'unavailable' && prior.errorCode === AGENT_TERMINAL_HANDSHAKE_FAILED) {
          throw new AgentMuxError(prior.error ?? 'The original restart replacement exited during startup.', prior.errorCode)
        }
        if (prior.newRun && prior.kind === 'resumed') {
          if (!sameRun(prior.newRun, canonical.run)) throw new AgentMuxError('The restart completed on its original successor, and this Session has since changed. Inspect the original restart.', 'STALE_AGENT_SESSION')
          return this.ports.events.projectSession(canonical)
        }
      }
      if (!sameRun(canonical.run, input.expectedRun)) throw new AgentMuxError('Agent Session changed before explicit restart. The current Run was kept.', 'STALE_AGENT_SESSION', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
      let reservation = await this.ports.sessions.store.loadResumeCorrelation(input.agentSessionId, operation)
      if (reservation) {
        if (identityOnly && !prior && reservation.restart) digest = reservation.restart.requestDigest
        if (!reservation.restart || reservation.restart.requestDigest !== digest ||
          !matchesProviderNativeSessionTarget(reservation.restart.nativeTarget, canonical.nativeHandle)) {
          throw new AgentMuxError('The original restart has another frozen request or native target.', 'AGENT_RESTART_CONFLICT')
        }
        reservation = await this.ports.sessions.registry.claimRestart(input.agentSessionId, operation)
        if (!reservation) throw new AgentMuxError('The original restart reservation is unconfirmed.', 'AGENT_RESTART_UNCONFIRMED')
        if (reservation.preparedSession) {
          const restored = await this.completePreparedResume(reservation, await this.ports.runtime.kernel.list())
          if (restored) return this.ports.events.projectSession(restored)
          throw new AgentMuxError('The original restart Start has no single confirmed Run. Inspect the same operation; no Start was repeated.',
            'AGENT_RESTART_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
        }
      } else {
        if (prior) throw new AgentMuxError('The original restart reservation is unavailable. Keep its original intent and inspect it.', 'AGENT_RESTART_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
        const provider = this.ports.providers.providers.get(canonical.providerId)
        if (!canonical.nativeHandle || canonical.nativeHandle.kind !== 'provider' || provider.catalog.resumeStrategy.kind !== 'provider-native' ||
          canonical.observedNativeHandle && !matchesProviderNativeSessionTarget(canonical.nativeHandle, canonical.observedNativeHandle)) {
          throw new AgentMuxError('Restart needs the exact verified native conversation and Provider resume support. The original Run was kept.',
            'AGENT_RESUME_UNAVAILABLE', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
        }
        // Resolve the real replacement before interrupting useful work. Freeze these exact options in the original durable operation.
        const frozen = parseAgentRestartInput({ ...input, ...await this.ports.executors.sessionExecutorOptions(canonical, input) })
        const { plan } = this.buildResumePlan(canonical, frozen)
        const capability = await this.ports.providers.probeAgent(canonical.providerId, plan.command, { workspacePath: canonical.workspacePath, env: terminalEnvironment(plan.env) })
        if (!capability.installed && !(capability.providerId === provider.id && unconfirmedExecutableObservation(capability, plan.command))) throw executorUnavailableError(provider.label, capability)
        await this.ports.hooks.requireHookIngressOwner()
        const stopOperation = await this.ports.runtime.kernel.prepareStop(input.expectedRun.runId, operation + '-stop')
        reservation = await this.ports.sessions.registry.reserveRestart(input.agentSessionId, input.expectedRun, operation,
          { requestDigest: digest, request: frozen, nativeTarget: structuredClone(canonical.nativeHandle), stopOperation })
      }
      if (!prior) {
        const observedAt = Date.now()
        const admitted: AgentMuxContinuityOperation = { operationId: input.operationId, agentSessionId: input.agentSessionId,
          action: 'restart', trigger: 'manual', policy: normalizeAgentContinuityPolicy(), previousRun: { ...input.expectedRun },
          nativeTarget: structuredClone(reservation.restart!.nativeTarget), requestDigest: digest,
          admittedAt: observedAt, observedAt, rechecks: 0, kind: 'starting', reason: 'restart-stopping',
          evidence: { kind: 'run-unknown', observedAt, message: 'The original explicit restart was admitted.' },
          recoveryInputs: { reminder: '', continuation: '' } }
        const recorded = await this.ports.sessions.updateExactAgentSession(input.agentSessionId, input.expectedRun, session => ({ ...session,
          continuity: admitted, continuityOperations: { ...session.continuityOperations, [input.operationId]: admitted }, updatedAt: Math.max(session.updatedAt + 1, observedAt) }))
        this.ports.events.publishSession(recorded)
      }
      return await this.resumeAgentRun(reservation.restart!.request, input.expectedRun, undefined, undefined, digest, reservation)
    } finally { this.executingRestarts.delete(operation); this.restartSettlements.delete(operation); settle() }
  }

  async inspectAgentRestart(value: AgentMuxAgentRestartIdentity): Promise<AgentMuxAgentRestartInspection> {
    const input = parseAgentRestartInput(value, true)
    const result: AgentMuxAgentRestartInspection = { ...input, previousRun: { ...input.expectedRun }, phase: 'not-found', canRetry: true, observedAt: Date.now() }
    const canonical = await this.ports.sessions.store.readMetadata(input.agentSessionId)
    const prior = canonical?.continuityOperations?.[input.operationId]
    if (prior) {
      if (prior.action !== 'restart' || !sameRun(prior.previousRun, input.expectedRun)) throw new AgentMuxError('The operation names another original request.', 'AGENT_RESTART_CONFLICT')
      result.session = this.ports.events.projectSession(canonical!)
      if (prior.newRun && prior.kind === 'resumed') return { ...result, phase: 'restarted', canRetry: false, newRun: { ...prior.newRun } }
      if (prior.newRun && prior.kind === 'unavailable' && prior.errorCode === AGENT_TERMINAL_HANDSHAKE_FAILED) return { ...result,
        phase: 'failed', canRetry: false, newRun: { ...prior.newRun }, detail: prior.error ?? 'The original replacement Run exited during startup.',
        failure: { code: prior.errorCode, message: prior.error ?? 'The original replacement Run exited during startup.', observedAt: prior.observedAt } }
    }
    const operation = agentLifecycleOperationIdentity('restart', input.agentSessionId, input.operationId)
    const reservation = await this.ports.sessions.store.loadResumeCorrelation(input.agentSessionId, operation)
    if (!reservation?.restart) return prior ? { ...result, phase: 'unconfirmed', canRetry: false, detail: 'The original restart reservation is unavailable; retain its original operation.' } : result
    if (!sameRun(reservation.expectedRun, input.expectedRun)) throw new AgentMuxError('The original restart Run changed.', 'AGENT_RESTART_CONFLICT')
    if (canonical) result.session = this.ports.events.projectSession(canonical)
    if (reservation.restart.startNotApplied) return { ...result, phase: 'starting', canRetry: true, detail: 'The original Run stopped. Its replacement Start was confirmed not applied; explicitly retry this same operation and frozen plan.' }
    if (reservation.preparedSession) {
      const candidates = (await this.ports.runtime.kernel.list()).filter(run => run.lifecycleOperationId === operation)
      const frozen = reservation.preparedSession.continuity?.restartLaunch
      if (candidates.length === 1 && candidates[0]!.workspacePath === reservation.preparedSession.workspacePath && frozen &&
        frozen.program === candidates[0]!.program && frozen.argsDigest === createHash('sha256').update(JSON.stringify(candidates[0]!.args)).digest('base64url')) {
        return { ...result, phase: 'starting', canRetry: true, newRun: runRef(candidates[0]!.runId), detail: 'Original Start found; repeat the same restart request to confirm its Session commit.' }
      }
      return { ...result, phase: 'unconfirmed', canRetry: false, detail: 'The original Start is unconfirmed. No Start or input was repeated.' }
    }
    try {
      const run = await this.ports.runtime.kernel.status(input.expectedRun.runId)
      if (canonical) this.ports.runtime.assertAgentRun(canonical, run)
      return { ...result, phase: run.state.type === 'running' ? 'stopping' : 'starting' }
    } catch (error) {
      return { ...result, phase: error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found' ? 'starting' : 'unconfirmed',
        detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async resumeAgent(input: AgentMuxAgentResumeInput): Promise<AgentMuxAgentSession> {
    this.ports.connection.requireConnected()
    if (!input.prompt.trim() && !input.agentMuxNote?.trim()) throw new AgentMuxError('Agent resume prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    const lifecycleId = agentLifecycleOperationIdentity('resume', safeId(input.agentSessionId, 'Agent Session id'), safeId(input.operationId, 'Agent resume operation id'))
    const requestDigest = agentCreationIntentDigest(input)
    return await this.serializeAgentContinuity(input.agentSessionId, async () => {
      await this.ports.sessions.resolveRawAgentSession(input.agentSessionId)
      const canonical = await this.ports.sessions.store.readMetadata(input.agentSessionId)
      if (!canonical || canonical.hostId !== 'local') throw new AgentMuxError('The original Session is unavailable on this Host.', 'UNKNOWN_AGENT_SESSION')
      const reservation = await this.ports.sessions.store.loadResumeCorrelation(input.agentSessionId, lifecycleId)
      const prior = canonical.continuityOperations?.[input.operationId] ?? reservation?.preparedSession?.continuityOperations?.[input.operationId]
      if (prior) {
        if (prior.requestDigest !== requestDigest || !matchesProviderNativeSessionTarget(prior.nativeTarget, canonical.nativeHandle)) throw new AgentMuxError(
          'This original resume has another frozen request or native target. Its original Run and input are kept.', 'AGENT_PROMPT_OPERATION_CONFLICT')
        if (prior.errorCode) throw new AgentMuxError(prior.error ?? 'The original resume failed.', prior.errorCode)
        if (prior.newRun && sameRun(prior.newRun, canonical.run) && prior.kind === 'resumed') {
          await this.ports.sessions.registry.refresh(input.agentSessionId)
          const restored = prior.launchInput?.delivery === 'post-launch'
            ? await this.settleContinuityPostLaunchInput(this.ports.sessions.registry.get(input.agentSessionId), input.operationId) : this.ports.sessions.registry.get(input.agentSessionId)
          return this.ports.events.projectSession(restored)
        }
        if (reservation?.preparedSession && sameRun(reservation.expectedRun, canonical.run)) {
          const restored = await this.completePreparedResume(reservation, await this.ports.runtime.kernel.list())
          if (restored) return this.ports.events.projectSession(restored)
        }
        throw new AgentMuxError('The original resume result is unconfirmed. Inspect the same operation; no Start or input was repeated.',
          'AGENT_RESUME_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
      }
      await this.ports.sessions.registry.refresh(input.agentSessionId)
      return await this.resumeAgentRun(input, canonical.run, undefined, undefined, requestDigest)
    })
  }

  async reopenAgent(input: AgentMuxAgentReopenInput): Promise<AgentMuxAgentSession> {
    if (this.reopensDisposed) throw new AgentMuxError('This continue owner has been disposed. Use the current Core client.', 'AGENT_REOPEN_OWNER_DISPOSED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    const fields = ['agentSessionId', 'expectedRetiredAt', 'operationId', 'args', 'env', 'commandOverride', 'launchOptions', 'cols', 'rows']
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !fields.includes(key)) ||
      !Number.isSafeInteger(input.expectedRetiredAt) || input.expectedRetiredAt < 0 ||
      typeof input.agentSessionId !== 'string' || !input.agentSessionId || input.agentSessionId === 'self' ||
      (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string'))) ||
      (input.env !== undefined && (!input.env || typeof input.env !== 'object' || Array.isArray(input.env) || Object.values(input.env).some(value => typeof value !== 'string'))) ||
      (input.commandOverride !== undefined && (typeof input.commandOverride !== 'string' || !input.commandOverride))) {
      throw new AgentMuxError('Explicit continue requires the exact retired Session and valid current launch configuration.', 'INVALID_AGENT_REOPEN', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    }
    const operation = agentLifecycleOperationIdentity('reopen', input.agentSessionId, safeId(input.operationId, 'Agent reopen operation id'))
    if (this.executingReopens.has(operation)) throw this.reopenUnconfirmed('The original continue operation is still executing.')
    this.executingReopens.add(operation)
    let settle!: () => void
    this.reopenSettlements.set(operation, new Promise<void>(resolve => { settle = resolve }))
    try { return await this.resumeAgentRun(input, undefined, undefined, input) }
    catch (error) {
      if (error instanceof AgentMuxError && !error.controlFailure &&
        ['STALE_AGENT_SESSION', 'CTXMUX_DISCONNECTED', 'INVALID_AGENT_SESSION_ID'].includes(error.code)) {
        throw new AgentMuxError(error.message, error.code, error.detail, { disposition: 'not_applied', confirmedInputBytes: null })
      }
      throw error
    } finally { this.executingReopens.delete(operation); this.reopenSettlements.delete(operation); settle() }
  }

  async reconcileAgentReopen(input: Pick<AgentMuxAgentReopenInput, 'agentSessionId' | 'expectedRetiredAt' | 'operationId'>): Promise<AgentMuxAgentSession> {
    if (this.reopensDisposed) throw this.reopenUnconfirmed('This continue owner has been disposed. Confirm the original operation through the current Core client.')
    this.ports.connection.requireConnected()
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['agentSessionId', 'expectedRetiredAt', 'operationId'].includes(key)) ||
      typeof input.agentSessionId !== 'string' || !input.agentSessionId || !Number.isSafeInteger(input.expectedRetiredAt) || input.expectedRetiredAt < 0) {
      throw new AgentMuxError('Original continue confirmation requires its exact identity.', 'INVALID_AGENT_REOPEN', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    }
    const operationId = agentLifecycleOperationIdentity('reopen', input.agentSessionId, safeId(input.operationId, 'Agent reopen operation id'))
    if (this.executingReopens.has(operationId)) throw this.reopenUnconfirmed('The original continue operation is still executing.')
    this.executingReopens.add(operationId)
    let settle!: () => void
    this.reopenSettlements.set(operationId, new Promise<void>(resolve => { settle = resolve }))
    try {
      const canonical = (await this.ports.sessions.store.readMetadata(input.agentSessionId))
      if (canonical) {
        const run = await this.ports.runtime.kernel.status(canonical.run.runId)
        if (canonical.reopenedFrom?.observedAt !== input.expectedRetiredAt || run.lifecycleOperationId !== operationId) {
          throw this.reopenUnconfirmed('The Session has a different current lifecycle operation. Read its actual state.')
        }
        await this.ports.sessions.registry.load('local')
        await this.restoreReopenObservation(canonical, run, operationId)
        return this.ports.events.projectSession(this.ports.sessions.registry.get(canonical.agentSessionId))
      }
      const reservation = await this.ports.sessions.registry.claimReopen(input.agentSessionId, operationId, input.expectedRetiredAt)
      if (!reservation) throw this.reopenUnconfirmed('The original continue result has not been confirmed.')
      return this.ports.events.projectSession(await this.completePreparedReopen(reservation, await this.ports.runtime.kernel.list()))
    } catch (error) {
      if (error instanceof AgentMuxError && error.controlFailure) throw error
      throw this.reopenUnconfirmed(error instanceof Error ? error.message : String(error))
    } finally { this.executingReopens.delete(operationId); this.reopenSettlements.delete(operationId); settle() }
  }

  private reopenUnconfirmed(message: string): AgentMuxError {
    return new AgentMuxError(message, 'AGENT_REOPEN_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
  }

  async completePreparedReopen(
    reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, runs: readonly CtxmuxAdapterRun[]
  ): Promise<AgentMuxStoredAgentSession> {
    const prepared = reservation.preparedSession
    const candidates = runs.filter(run => run.lifecycleOperationId === reservation.operationId)
    if (!prepared || candidates.length !== 1 || candidates[0]!.workspacePath !== prepared.workspacePath ||
      candidates[0]!.runId === reservation.expectedRetirement.run.runId) {
      throw this.reopenUnconfirmed('The original continue has no single confirmed matching Run. Keep its history and check again.')
    }
    const run = candidates[0]!, retirement = reservation.expectedRetirement
    const nativeBindingObservedAt = Date.now()
    const next: AgentMuxStoredAgentSession = { ...structuredClone(prepared), run: runRef(run.runId), retiredRuns: [retirement.run],
      reopenedFrom: { run: retirement.run, source: retirement.source, observedAt: retirement.observedAt }, updatedAt: Math.max(prepared.updatedAt + 1, nativeBindingObservedAt),
      ...(prepared.nativeHandle ? { nativeBinding: { source: 'semantic-resume-target' as const, run: runRef(run.runId), observedAt: nativeBindingObservedAt } } : {}) }
    // A lost start ACK cannot reconstruct a pre-start Provider observation.
    delete next.nativePromptPredecessor
    try { await this.ports.sessions.registry.commitLifecycle(reservation, next) }
    catch (error) {
      const canonical = (await this.ports.sessions.store.readMetadata(prepared.agentSessionId))
      if (!canonical || canonical.run.runId !== run.runId || JSON.stringify(canonical.reopenedFrom) !== JSON.stringify(next.reopenedFrom)) throw error
      await this.ports.sessions.registry.load('local')
    }
    await this.restoreReopenObservation(this.ports.sessions.registry.get(next.agentSessionId), run, reservation.operationId)
    return this.ports.sessions.registry.get(next.agentSessionId)
  }

  private async restoreReopenObservation(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun, operationId: string): Promise<void> {
    try {
      if (!this.ports.hooks.hookBindings.has(run.runId)) {
        await this.ports.hooks.requireHookIngressOwner()
        const binding = this.ports.hooks.pendingLifecycleBindings.get(operationId) ?? this.ports.hooks.hookServer.createBinding(
          session.agentSessionId, session.providerId, session.hookBindingId, session.hookToken)
        this.ports.hooks.pendingLifecycleBindings.set(operationId, binding)
        await binding.bindRun(run.runId)
        this.ports.hooks.hookBindings.set(run.runId, binding)
        this.ports.hooks.pendingLifecycleBindings.delete(operationId)
      }
    } catch (error) {
      this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: 'AGENT_REOPEN_OBSERVATION_UNCONFIRMED',
        message: `The original conversation has Run ${run.runId}; its Hook observation is unconfirmed. Keep this Run and check again. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now() } })
    }
    this.ports.runtime.runPids.set(run.runId, run.pid)
    this.ports.events.publishSession(session)
    this.ports.events.publisher.publishRunState(this.ports.events.projectRun(run, this.ports.sessions.registry.get(session.agentSessionId)), session.agentSessionId)
  }

  private buildResumePlan(session: Pick<AgentMuxAgentSession, 'workspacePath' | 'providerId' | 'nativeHandle' | 'launchOptions'>,
    input: Pick<AgentMuxAgentResumeOperationInput, 'args' | 'env' | 'commandOverride'>, prompt?: string) {
    const provider = this.ports.providers.providers.get(session.providerId)
    const resumeLaunchOptionArgv = provider.resolveLaunchArgv(session.launchOptions ?? {})
    // 与 launch 同一条判据、同一个函数：`post-launch-only` 的 Provider 续跑时也收不到启动期
    // prompt，于是不把它交给 buildResumeLaunch（交了只会被拒），改在下面进程起来之后键入。
    const { atLaunch: launchTimePrompt, deferred: deferredResumePrompt } =
      splitLaunchPromptByDelivery(provider.catalog, prompt ?? '')
    const plan = provider.buildResumeLaunch({
      workspacePath: session.workspacePath,
      nativeHandle: session.nativeHandle!,
      ...(launchTimePrompt ? { prompt: launchTimePrompt } : {}),
      args: [...(input.args ?? []), ...resumeLaunchOptionArgv],
      env: input.env ?? {},
      ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride })
    })
    return { plan, deferredResumePrompt }
  }

  private async resumeAgentRun(
    input: AgentMuxAgentResumeOperationInput,
    expectedRun?: AgentMuxRunRef,
    knownCapability?: { snapshot: AgentCapabilitySnapshot; context: { workspacePath: string; env: Record<string, string> } },
    reopening?: AgentMuxAgentReopenInput,
    directRequestDigest?: string,
    restartReservation?: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>
  ): Promise<AgentMuxAgentSession> {
    this.ports.connection.requireConnected()
    const previous = reopening ? undefined : this.ports.sessions.requireAgentSession(input.agentSessionId)
    let continuity = previous?.continuityOperations?.[input.operationId] ? structuredClone(previous.continuityOperations[input.operationId])
      : previous?.continuity?.operationId === input.operationId ? structuredClone(previous.continuity) : undefined
    if (expectedRun && previous && !sameRun(previous.run, expectedRun)) {
      throw new AgentMuxError('Agent Session changed before native resume.', 'STALE_AGENT_SESSION')
    }
    const frozenInput = continuity?.launchInput
    const composed = frozenInput ? { text: frozenInput.prompt, systemContext: frozenInput.message.systemContext }
      : composeAgentResumePrompt(input.prompt, input.agentMuxNote)
    assertAgentPromptSize(composed.text)
    const prompt = composed.text || undefined
    const message: AgentPromptMessageContent = frozenInput?.message ?? {
      ...(composed.systemContext ? { systemContext: composed.systemContext } : {}),
      ...(input.prompt?.trim() ? { userContent: input.prompt } : {})
    }
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      restartReservation ? 'restart' : reopening ? 'reopen' : 'resume', input.agentSessionId,
      safeId(input.operationId, 'Agent resume operation id')
    )
    let reservation = restartReservation ?? (reopening
      ? await this.ports.sessions.registry.reserveReopen(input.agentSessionId, reopening.expectedRetiredAt, lifecycleOperationId, input.operationId)
      : await this.ports.sessions.registry.reserveExisting('resume', previous!.agentSessionId, previous!.run, lifecycleOperationId))
    let hookBinding: AgentHookBinding | null = null
    let persisted: AgentMuxStoredAgentSession | null = null
    let abandonedRun: AgentMuxRunRef | null = null
    let operationError: unknown = null
    let preserveUnconfirmedRun = false
    let launchAttempted = false
    let hookBound = false
    try {
      const retirement = reservation.kind === 'reopen' ? reservation.expectedRetirement : undefined
      if (retirement && (!retirement.history || retirement.hostId !== 'local')) {
        throw new AgentMuxError('The original retired native identity is unavailable on this Host.', 'AGENT_RESUME_UNAVAILABLE')
      }
      const current = previous ?? {
        ...retirement!.history!, kind: 'agent' as const, agentSessionId: retirement!.agentSessionId,
        hostId: retirement!.hostId, run: retirement!.run, retiredRuns: [],
        updatedAt: retirement!.observedAt,
        ...(retirement!.activityCommit === undefined ? {} : { activityCommit: structuredClone(retirement!.activityCommit) }),
        ...(retirement!.continuityControlReceipts === undefined ? {} : { continuityControlReceipts: structuredClone(retirement!.continuityControlReceipts) }),
        ...(reopening?.launchOptions === undefined ? {} : { launchOptions: reopening.launchOptions })
      }
      if (!current.nativeHandle || current.nativeHandle.kind !== 'provider') {
        throw new AgentMuxError('Provider-native resume requires a verified provider session handle.', 'AGENT_RESUME_UNAVAILABLE')
      }
      if ('observedNativeHandle' in current && current.observedNativeHandle && current.observedNativeHandle.sessionId !== current.nativeHandle.sessionId) {
        throw new AgentMuxError('The retained native resume target differs from this Run’s confirmed native source. Confirm the original target; no new Run was started.', 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
      }
      let oldRun: CtxmuxAdapterRun | null = null
      try {
        oldRun = await this.ports.runtime.kernel.status(current.run.runId)
        if (retirement) {
          if (oldRun.runId !== retirement.run.runId || oldRun.workspacePath !== current.workspacePath) {
            throw new AgentMuxError('The retired Run no longer matches its original native Session.', 'AGENT_SESSION_RUN_MISMATCH')
          }
        } else this.ports.runtime.assertAgentRun(current, oldRun)
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') throw error
      }
      if (oldRun?.state.type === 'running' && !restartReservation) {
        throw new AgentMuxError('Cannot resume while the original Run is still running.', 'AGENT_SESSION_STILL_RUNNING')
      }
      if (directRequestDigest && (!restartReservation || !continuity)) {
        const now = Date.now()
        continuity = { operationId: input.operationId, agentSessionId: current.agentSessionId, trigger: restartReservation ? 'manual' : 'input',
          ...(restartReservation ? { action: 'restart' as const } : {}),
          policy: normalizeAgentContinuityPolicy(), previousRun: { ...current.run }, nativeTarget: structuredClone(current.nativeHandle),
          admittedAt: now, observedAt: now, rechecks: 0, kind: 'starting', reason: 'explicit-request', requestDigest: directRequestDigest,
          evidence: oldRun ? { kind: 'run-ended', state: oldRun.state.type as 'exited' | 'interrupted', observedAt: now } : { kind: 'run-missing', observedAt: now },
          recoveryInputs: { reminder: '', continuation: '' } }
        const directInput = prepareContinuityLaunchInput(continuity, this.ports.providers.providers.get(current.providerId).catalog,
          lifecycleOperationId, { submissionId: `launch-prompt:${lifecycleOperationId}`, prompt: input.prompt ?? '',
            ...(input.agentMuxNote === undefined ? {} : { agentMuxNote: input.agentMuxNote }) })
        if (directInput) continuity.launchInput = directInput
      }
      // Continuity already froze this configuration together with its capability probe.
      if (!knownCapability && !restartReservation) input = await this.ports.executors.sessionExecutorOptions(current, input)
      const provider = this.ports.providers.providers.get(current.providerId)
      if (reopening && provider.catalog.resumeStrategy.kind !== 'provider-native') {
        throw new AgentMuxError('This Provider does not support continuing its retired native conversation.', 'AGENT_RESUME_UNAVAILABLE')
      }
      // resume 换了 Run，就换一枚凭证——旧 Run 的那枚随之作废，不能再以此 Agent 名义说话。
      const invocationCapability = issueAgentCapability()
      // Re-resolve the posture the create fixed and append it to the resume args exactly as createAgent
      // does, so the sandbox/approval/permission-mode flags survive the stop/resume boundary rather than
      // reverting to the Provider's more permissive default. The Provider owns the native argument
      // order and the prompt's data boundary; Core retains the configured invocation intact.
      let { plan, deferredResumePrompt } = this.buildResumePlan(current, input, prompt)
      const executableContext = { workspacePath: current.workspacePath, env: terminalEnvironment(plan.env) }
      const capability = knownCapability?.snapshot.providerId === current.providerId && knownCapability.snapshot.executable === plan.command &&
        isDeepStrictEqual(knownCapability.context, executableContext)
        ? knownCapability.snapshot : await this.ports.providers.probeAgent(current.providerId, plan.command, executableContext)
      if (!capability.installed && !(capability.providerId === provider.id && unconfirmedExecutableObservation(capability, plan.command))) {
        throw executorUnavailableError(provider.label, capability)
      }
      const originalExecutable = plan.command
      const managedLaunch = await provider.prepareManagedLaunch?.(plan, lifecycleOperationId, { kind: 'resume', ...(prompt === undefined ? {} : { prompt }) })
      if (managedLaunch) plan = managedLaunch.plan
      if (managedLaunch?.promptDelivery === 'post-launch' && prompt) {
        deferredResumePrompt = prompt
        if (continuity?.launchInput) {
          if (continuity.launchInput.state !== 'prepared' || continuity.launchInput.key || continuity.launchInput.launchPlan) throw new AgentMuxError(
            'The original input delivery plan was already dispatched or frozen. Its original receipt is retained.', 'AGENT_PROMPT_OPERATION_CONFLICT')
          // Provider qualification precedes prepareResume's immutable launch plan.
          // Only the carrier converges; original key/body/message remain unchanged.
          continuity.launchInput.delivery = 'post-launch'
        }
      }
      const withoutPreviousNativeActor = { ...current }
      delete (withoutPreviousNativeActor as Partial<AgentMuxStoredAgentSession>).nativeActor
      const nativeSession = { ...withoutPreviousNativeActor, ...(managedLaunch?.nativeActor ? { nativeActor: managedLaunch.nativeActor } : {}) }
      await this.ports.hooks.requireHookIngressOwner()
      if (restartReservation) {
        if (!matchesProviderNativeSessionTarget(restartReservation.restart?.nativeTarget, current.nativeHandle)) throw new AgentMuxError('The original restart native target changed.', 'AGENT_RESTART_CONFLICT')
        if (oldRun?.state.type === 'running') {
          this.ports.runtime.stopRequestedRuns.add(current.run.runId)
          try { await this.ports.runtime.kernel.stop(restartReservation.restart!.stopOperation) }
          catch (error) {
            if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') throw new AgentMuxError(
              `The original restart Stop is unconfirmed. Inspect or retry the same operation. ${error instanceof Error ? error.message : String(error)}`,
              'AGENT_RESTART_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
          }
        }
        // A Stop acknowledgement is not a substitute for the exact old Run's terminal state.
        try { oldRun = await this.ports.runtime.kernel.status(current.run.runId); this.ports.runtime.assertAgentRun(current, oldRun) }
        catch (error) { if (error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found') oldRun = null; else throw error }
        if (oldRun?.state.type === 'running') throw new AgentMuxError('The original Run has not ended. No replacement was started.',
          'AGENT_RESTART_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
        if (continuity) continuity.evidence = oldRun ? { kind: 'run-ended', state: oldRun.state.type as 'exited' | 'interrupted', observedAt: Date.now() } : { kind: 'run-missing', observedAt: Date.now() }
        if (continuity) {
          continuity.reason = 'restart-starting'
          const pending = structuredClone(continuity)
          this.ports.events.publishSession(await this.ports.sessions.updateExactAgentSession(current.agentSessionId, current.run, session => ({ ...session,
            continuity: pending, continuityOperations: { ...session.continuityOperations, [input.operationId]: pending }, updatedAt: Math.max(session.updatedAt + 1, Date.now()) })))
        }
      }
      await this.ports.hooks.hookBindings.get(current.run.runId)?.close()
      this.ports.hooks.hookBindings.delete(current.run.runId)
      this.ports.hooks.settleHookRestore(current)
      hookBinding = this.ports.hooks.hookServer.createBinding(
        current.agentSessionId,
        current.providerId,
        hookBindingIdentity(lifecycleOperationId)
      )
      // resume 换新 Run 就换新凭证（见下面 `hookToken` 那行），所以把**投递代码写进文件**的
      // Provider 必须在这里重装：opencode 的插件里 URL 与 token 是写盘时内联的字面量，磁盘上
      // 那份仍拿着刚被 delete 掉的旧 token，而 ingress 对认不出的 token 一律 403
      // （hook-server.ts 的 `if (!binding) respond(403)`）。少了这一次重装，resume 之后
      // OpenCode 的每条状态事件都被静默拒收：Agent 永远不 done、完成通知永不触发，且没有
      // 任何报错——插件"装着"，只是每条都 403。
      //
      // 对写命令的那九家是幂等 no-op（内容不含 token，`ensure` 见 hash 相同便不碰盘），
      // 对 pi 也是（它运行时从自己进程的环境变量取值，token 一个字节都不落盘）。
      await this.ports.hooks.ensureManagedHooks(
        provider,
        current.workspacePath,
        current.agentSessionId,
        input.env ?? {},
        hookBinding.endpoint
      )
      if (reservation.kind === 'reopen') {
        const preparedSession: AgentMuxStoredAgentSession = { ...nativeSession, kind: 'agent', run: current.run, retiredRuns: [],
          hookBindingId: hookBinding.bindingId, hookToken: hookBinding.endpoint.token,
          capabilityHash: hashAgentCapability(invocationCapability), updatedAt: Date.now(), nativeHandle: structuredClone(current.nativeHandle) }
        delete preparedSession.nativePromptPredecessor
        reservation = await this.ports.sessions.registry.prepareReopen(reservation, preparedSession)
        this.ports.hooks.pendingLifecycleBindings.set(lifecycleOperationId, hookBinding)
      }
      if (reopening && this.reopensDisposed) throw new AgentMuxError('Continue owner was disposed before dispatch.', 'AGENT_REOPEN_OWNER_DISPOSED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
      // The Provider's old turn belongs to the Run that just ended, even when its
      // transcript has no native completion/abort. Freeze it before the new writer
      // starts; an unknown observation never prevents healthy native restoration.
      const nativePromptEvidence = provider.readPromptExecutionEvidence
        ? await provider.readPromptExecutionEvidence({ args: oldRun ? this.ports.providers.providerLaunch(current as AgentMuxAgentSession, oldRun).args : [], workspacePath: current.workspacePath,
          nativeHandle: current.nativeHandle }).catch(error => {
          this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: current.agentSessionId,
            code: 'AGENT_NATIVE_SOURCE_UNCONFIRMED',
            message: `The previous native turn could not be observed. Native restoration and ordinary input remain available; immediate input needs current source confirmation. ${error instanceof Error ? error.message : String(error)}`,
            evidence: { source: 'agentmux', run: { ...current.run }, observedAt: Date.now() } })
          return null
        }) : null
      const launchEnvironment = this.ports.hooks.agentEnvironment(plan.env, current.agentSessionId, current.providerId, current.executorId,
        hookBinding, lifecycleOperationId, invocationCapability)
      if (reservation.kind === 'resume' && continuity?.operationId === input.operationId) {
        if (restartReservation) {
          const identity = this.ports.runtime.kernel.launchIdentity({ program: plan.command, args: plan.args, env: launchEnvironment })
          if (restartReservation.restart?.startNotApplied && continuity.restartLaunch && !isDeepStrictEqual(continuity.restartLaunch, identity)) throw new AgentMuxError(
            'The original not-applied restart launch changed. Its original plan and native identity are retained.', 'AGENT_RESTART_CONFLICT')
          continuity.restartLaunch = identity
        }
        if (continuity.launchInput) continuity.launchInput.launchPlan = this.ports.runtime.kernel.launchIdentity({ program: plan.command, args: plan.args, env: launchEnvironment })
        reservation = await this.ports.sessions.registry.prepareResume(reservation, { ...nativeSession, continuity,
          continuityOperations: { ...previous?.continuityOperations, [input.operationId]: continuity },
          hookBindingId: hookBinding.bindingId, hookToken: hookBinding.endpoint.token,
          capabilityHash: hashAgentCapability(invocationCapability) })
        this.ports.hooks.pendingLifecycleBindings.set(lifecycleOperationId, hookBinding)
      }
      launchAttempted = true
      const run = await this.ports.runtime.kernel.start({
        operationKey: lifecycleOperationId,
        program: plan.command,
        args: plan.args,
        cwd: current.workspacePath,
        env: launchEnvironment,
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      }).catch(async error => {
        if (!(error instanceof AgentMuxError && error.controlFailure?.disposition === 'not_applied')) {
          // A lost start ACK may already own a Run. Keep the one reservation until authoritative reconciliation.
          preserveUnconfirmedRun = true
          throw new AgentMuxError(`Continue start is unconfirmed. Read the original Session; no operation was resent. ${error instanceof Error ? error.message : String(error)}`,
            reopening ? 'AGENT_REOPEN_UNCONFIRMED' : 'AGENT_RESUME_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
        }
        if (restartReservation && reservation.kind === 'resume') {
          const failure = { code: error.code, message: error.message, observedAt: Date.now() }
          reservation = await this.ports.sessions.registry.recordRestartStartNotApplied(reservation, failure)
          const pending = await this.ports.sessions.updateExactAgentSession(current.agentSessionId, current.run, value => {
            const original = value.continuityOperations?.[input.operationId] ?? continuity!
            const retained = { ...original, reason: 'restart-start-not-applied', errorCode: error.code, error: error.message,
              ...(continuity?.restartLaunch ? { restartLaunch: continuity.restartLaunch } : {}), observedAt: failure.observedAt }
            return { ...value, continuity: retained, continuityOperations: { ...value.continuityOperations, [input.operationId]: retained } }
          })
          this.ports.events.publishSession(pending)
          throw new AgentMuxError('The original Run stopped; replacement Start was confirmed not applied. Check or explicitly retry the same original restart.',
            'AGENT_RESTART_START_NOT_APPLIED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
        }
        throw error
      })
      this.ports.events.publishExecutableCheckFailure(provider.label, current.agentSessionId, lifecycleOperationId, originalExecutable, capability, run)
      const nativeBindingObservedAt = Date.now()
      const next: AgentMuxStoredAgentSession = {
        ...nativeSession,
        kind: 'agent',
        ...(retirement ? { reopenedFrom: { run: { ...retirement.run }, source: retirement.source, observedAt: retirement.observedAt } } : {}),
        run: runRef(run.runId),
        retiredRuns: [...current.retiredRuns, current.run],
        hookBindingId: hookBinding.bindingId,
        hookToken: hookBinding.endpoint.token,
        // 新 Run 换新凭证：旧 Run 的那枚从此认不出来，无法再以此 Agent 名义说话。
        capabilityHash: hashAgentCapability(invocationCapability),
        updatedAt: Math.max(current.updatedAt + 1, nativeBindingObservedAt),
        nativeHandle: structuredClone(current.nativeHandle),
        nativeBinding: { source: 'semantic-resume-target', run: runRef(run.runId), observedAt: nativeBindingObservedAt }
      }
      if (continuity?.operationId === input.operationId && continuity.kind === 'starting') {
        next.continuity = { ...continuity, kind: 'resumed', newRun: { ...next.run }, observedAt: Date.now() }
        if (run.acceptedInputBytes !== null) next.continuity.resumedInputBoundary = { initialInputByte: run.acceptedInputBytes }
        if (restartReservation) { delete next.continuity.errorCode; delete next.continuity.error }
        bindContinuityLaunchInput(next.continuity, next.run)
        const recoveryDelivery = createContinuityInputDelivery(next.continuity, run.acceptedInputBytes ?? undefined)
        if (recoveryDelivery) next.continuity.recoveryDelivery = recoveryDelivery
        next.continuityOperations = { ...previous?.continuityOperations, [input.operationId]: next.continuity }
      }
      delete next.observedNativeHandle
      delete next.nativeSourceObservation
      delete next.recoveryActivity
      delete next.nativePromptPredecessor
      if (nativePromptEvidence) next.nativePromptPredecessor = {
        run: runRef(run.runId), previousRun: { ...current.run },
        sourceId: nativePromptEvidence.sourceId, evidenceId: nativePromptEvidence.id
      }
      delete next.hookReceipt
      delete next.terminalHandshake
      delete next.terminalCapability
      delete next.terminalPromptReadiness
      delete next.promptCompletionAdmission
      delete next.terminalPromptSubmission
      delete next.terminalPromptDelivery
      delete next.terminalOutputChannel
      delete next.semanticStatus
      delete next.pendingInteraction
      if (
        !prompt &&
        (input.args?.length ?? 0) === 0 &&
        provider.terminalHandshake &&
        provider.terminalPromptRender
      ) {
        const handshakeOperationId = terminalHandshakeOperationIdentity(
          next.providerId,
          next.run.runId,
          provider.terminalHandshake
        )
        next.terminalPromptReadiness = {
          source: 'initial-composer',
          id: terminalInitialPromptReadinessIdentity(next, handshakeOperationId),
          run: { ...next.run },
          outputCursorBytes: 0
        }
      }
      let readySession = next
      const rollbackFailedResume = async (failure: unknown): Promise<never> => {
        if (continuity?.supervision || continuity?.intentOperationId) {
          try {
            const retained = await this.ports.sessions.updateExactAgentSession(current.agentSessionId, next.run, value => {
              const failed = { ...(value.continuityOperations?.[input.operationId] ?? next.continuity!),
                errorCode: failure instanceof AgentMuxError ? failure.code : 'AGENT_RESUME_FAILED', error: failure instanceof Error ? failure.message : String(failure) }
              return { ...value, continuity: failed, continuityOperations: { ...value.continuityOperations, [input.operationId]: failed } }
            })
            this.ports.events.publishSession(retained); await this.ports.events.publishCurrentRunState(retained)
          } catch { preserveUnconfirmedRun = true; this.ports.hooks.pendingLifecycleBindings.set(lifecycleOperationId, hookBinding!) }
          throw failure
        }
        const rollbackErrors: unknown[] = [failure]
        try {
          await hookBinding!.close()
          this.ports.hooks.hookBindings.delete(run.runId)
          await this.ports.runtime.retireUncommittedRun(run.runId)
          abandonedRun = runRef(run.runId)
        }
        catch (cleanupError) { rollbackErrors.push(cleanupError) }
        if (persisted && previous) {
          try {
            const restored = await this.ports.sessions.registry.update(current.agentSessionId, next.run, failed => {
              const restored: AgentMuxStoredAgentSession = {
              ...previous,
              retiredRuns: [...previous.retiredRuns, next.run],
              // Renderer Run fences require a strictly newer canonical transition, even within
              // one clock tick or after a concurrent update of the failed binding.
              updatedAt: Math.max(Date.now(), failed.updatedAt + 1, next.updatedAt + 1)
              }
              if (next.continuity) {
                const failed = { ...next.continuity, kind: 'unavailable' as const, reason: 'process-exited',
                  errorCode: failure instanceof AgentMuxError ? failure.code : 'AGENT_RESUME_FAILED',
                  error: failure instanceof Error ? failure.message : String(failure) }
                restored.continuity = failed
                restored.continuityOperations = { ...previous.continuityOperations, [input.operationId]: failed }
              }
              delete restored.nativePromptPredecessor
              return restored
            })
            this.ports.events.publishSession(restored)
            if (oldRun) this.ports.events.publisher.publishRunState(this.ports.events.projectRun(oldRun, restored), restored.agentSessionId)
            abandonedRun = null
          } catch (cleanupError) {
            rollbackErrors.push(cleanupError)
          }
        }
        if (rollbackErrors.length > 1) {
          throw new AggregateError(rollbackErrors, 'Resume persistence and Run rollback failed.')
        }
        throw failure
      }
      try {
        try {
          persisted = await this.ports.sessions.registry.commitLifecycle(reservation, next)
          const carried = persisted?.continuity?.launchInput
          if (persisted && carried?.delivery === 'launch' && carried.state === 'launch-carried' && carried.key) await this.ports.input.recordAcceptedInput(carried.key, persisted.updatedAt)
        } catch (error) { persisted = this.ports.sessions.retainUnconfirmedLifecycle(error, next); readySession = persisted }
        // The Store atomically preserves a cancellation accepted after prepare. Refresh that exact
        // commit before publishing or observing the new binding; a stale prepared image cannot revive it.
        if (continuity?.supervision || continuity?.intentOperationId) readySession = await this.ports.sessions.registry.refresh(current.agentSessionId, next.run)
        await hookBinding.bindRun(run.runId)
        hookBound = true
        // Keep the committed native identity even when its observation fails.
        readySession = await this.ports.terminal.ensureTerminalHandshakeOrDegrade(
          retirement ? this.ports.sessions.registry.get(current.agentSessionId) : readySession, run)
      } catch (error) {
        if (!(error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED)) {
          const recoveredCommit = !persisted
          if (!persisted) {
            try {
              const canonical = (await this.ports.sessions.store.readMetadata(current.agentSessionId))
              if (canonical?.run.runId === run.runId && (reopening ? canonical.reopenedFrom && canonical.reopenedFrom.observedAt === retirement!.observedAt &&
                canonical.reopenedFrom.run.runId === retirement!.run.runId : canonical.continuity?.operationId === input.operationId && canonical.continuity.newRun?.runId === run.runId)) {
                await this.ports.sessions.registry.load('local')
                persisted = this.ports.sessions.registry.get(current.agentSessionId)
              }
            } catch (readError) {
              // Unknown commit acknowledgement cannot authorize stopping a possibly committed healthy Run.
              preserveUnconfirmedRun = true
              this.ports.hooks.pendingLifecycleBindings.set(lifecycleOperationId, hookBinding)
              throw new AggregateError([error, readError], 'Continue result is unconfirmed. Read the same Session; no operation was resent.')
            }
          }
          if (persisted) {
            this.ports.hooks.hookBindings.set(run.runId, hookBinding)
            this.ports.hooks.pendingLifecycleBindings.delete(lifecycleOperationId)
            readySession = this.ports.sessions.registry.get(current.agentSessionId)
            if (!hookBound) this.ports.hooks.observeHookRestoreFailure(readySession, 'binding', error)
            let observationError: unknown = error
            if (recoveredCommit) {
              try {
                await hookBinding.bindRun(run.runId)
                hookBound = true
                this.ports.hooks.hookBindings.set(run.runId, hookBinding)
                this.ports.hooks.pendingLifecycleBindings.delete(lifecycleOperationId)
                readySession = await this.ports.terminal.ensureTerminalHandshakeOrDegrade(readySession, run)
                observationError = null
              } catch (readError) {
                if (readError instanceof AgentMuxError && readError.code === AGENT_TERMINAL_HANDSHAKE_FAILED) {
                  await rollbackFailedResume(readError)
                }
                observationError = readError
              }
            }
            if (observationError !== null) this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: current.agentSessionId,
              code: 'AGENT_REOPEN_OBSERVATION_UNCONFIRMED',
              message: `The original conversation continued on Run ${run.runId}, but its Hook or terminal observation is unconfirmed. Keep this Run and refresh its observation. ${observationError instanceof Error ? observationError.message : String(observationError)}`,
              evidence: { source: 'agentmux', run: { ...next.run }, observedAt: Date.now() } })
          } else {
            preserveUnconfirmedRun = true
            this.ports.hooks.pendingLifecycleBindings.set(lifecycleOperationId, hookBinding)
            if (reservation.kind !== 'resume') throw error
            if (next.continuity) {
              next.continuity = { ...next.continuity, reason: 'operation-unconfirmed',
                error: `The original resume commit is unconfirmed. Keep its Run and inspect the same operation. ${error instanceof Error ? error.message : String(error)}` }
              next.continuityOperations = { ...next.continuityOperations, [input.operationId]: next.continuity }
            }
            readySession = await this.ports.sessions.registry.rememberStartedResume(reservation, next)
            await this.restoreReopenObservation(readySession, run, lifecycleOperationId)
            hookBound = this.ports.hooks.hookBindings.has(run.runId)
            try { readySession = await this.ports.terminal.ensureTerminalHandshakeOrDegrade(readySession, run) }
            catch (observationError) {
              if (observationError instanceof AgentMuxError && observationError.code === AGENT_TERMINAL_HANDSHAKE_FAILED) throw observationError
            }
            this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: current.agentSessionId,
              code: 'AGENT_RESUME_UNCONFIRMED', message: next.continuity?.error ?? 'The original resume commit is unconfirmed.',
              evidence: { source: 'agentmux', run: { ...next.run }, observedAt: Date.now() } })
          }
        } else {
          await rollbackFailedResume(error)
        }
      }
      if (hookBound) this.ports.hooks.hookBindings.set(run.runId, hookBinding)
      this.ports.runtime.runPids.delete(current.run.runId)
      this.ports.runtime.runPids.set(run.runId, run.pid)
      this.ports.terminal.queueNativeIdentityCapture(readySession, input)
      this.ports.events.publishSession(readySession)
      await this.ports.events.publishCurrentRunState(readySession)
      if (preserveUnconfirmedRun) return this.ports.events.projectSession(readySession)
      // A deferred input receipt must precede the history's delivery status. A healthy Run remains
      // available when input confirmation fails; the retained history must not claim it was sent.
      let promptConfirmed = false
      if (continuity?.launchInput?.delivery === 'post-launch') {
        readySession = await this.settleContinuityPostLaunchInput(readySession, input.operationId)
        promptConfirmed = ['terminal-confirmed', 'native-admitted'].includes(readySession.continuityOperations?.[input.operationId]?.launchInput?.state ?? '')
      } else promptConfirmed = await this.ports.input.deliverPostLaunchPrompt(
        provider, readySession, run, lifecycleOperationId, deferredResumePrompt, continuity?.launchInput?.message ?? message,
        continuity?.launchInput?.input.submissionId)
      await this.ports.input.recordPromptMessageAfterSideEffect(readySession, continuity?.launchInput?.input.submissionId ?? lifecycleOperationId, 'Resume prompt', continuity?.launchInput?.message ?? message,
        promptConfirmed ? 'complete' : 'failed')
      return this.ports.events.projectSession(readySession)
    } catch (error) {
      operationError = error
      if (reopening && !preserveUnconfirmedRun && !persisted && (!launchAttempted || abandonedRun)) {
        throw new AgentMuxError(error instanceof Error ? error.message : String(error),
          error instanceof AgentMuxError ? error.code : 'AGENT_REOPEN_NOT_APPLIED',
          error instanceof AgentMuxError ? error.detail : undefined,
          { disposition: 'not_applied', confirmedInputBytes: null })
      }
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      if (hookBinding && !preserveUnconfirmedRun && ![...this.ports.hooks.hookBindings.values()].includes(hookBinding) &&
        !(persisted && this.ports.hooks.pendingLifecycleBindings.get(lifecycleOperationId) === hookBinding)) {
        try {
          await hookBinding.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        if (restartReservation && !preserveUnconfirmedRun && !persisted) this.ports.hooks.pendingLifecycleBindings.delete(lifecycleOperationId)
        if (!preserveUnconfirmedRun && !restartReservation) {
          if (!persisted || hookBound) this.ports.hooks.pendingLifecycleBindings.delete(lifecycleOperationId)
          await this.ports.sessions.registry.releaseLifecycle(reservation, abandonedRun ? [abandonedRun] : [])
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          operationError === null ? cleanupErrors : [operationError, ...cleanupErrors],
          'Resume lifecycle cleanup failed.'
        )
      }
    }
  }

  async completePreparedResume(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>,
    runs: readonly CtxmuxAdapterRun[]): Promise<AgentMuxStoredAgentSession | null> {
    const prepared = reservation.preparedSession
    const candidates = runs.filter(run => run.lifecycleOperationId === reservation.operationId)
    if (!prepared || candidates.length !== 1) return null
    const run = candidates[0]!
    if (reservation.restart && (!prepared.continuity?.restartLaunch || prepared.continuity.restartLaunch.program !== run.program ||
      prepared.continuity.restartLaunch.argsDigest !== createHash('sha256').update(JSON.stringify(run.args)).digest('base64url'))) {
      throw new AgentMuxError('The original restart Run does not match its frozen no-input launch.', 'AGENT_RESTART_CONFLICT')
    }
    if (run.runId === reservation.expectedRun.runId || run.workspacePath !== prepared.workspacePath) {
      throw new AgentMuxError('Original resume Run does not match the prepared target.', 'AGENT_SESSION_RUN_MISMATCH')
    }
    const observedAt = Date.now()
    const next: AgentMuxStoredAgentSession = { ...prepared, run: runRef(run.runId),
      retiredRuns: [...prepared.retiredRuns, prepared.run], updatedAt: Math.max(observedAt, prepared.updatedAt + 1),
      nativeBinding: { source: 'semantic-resume-target', run: runRef(run.runId), observedAt } }
    for (const key of ['observedNativeHandle', 'nativeSourceObservation', 'nativePromptPredecessor', 'hookReceipt', 'terminalHandshake',
      'terminalCapability', 'terminalPromptReadiness', 'promptCompletionAdmission', 'terminalPromptSubmission', 'terminalPromptDelivery',
      'terminalOutputChannel', 'semanticStatus', 'pendingInteraction', 'recoveryActivity'] as const) delete next[key]
    if (prepared.continuity) {
      next.continuity = { ...structuredClone(prepared.continuity), kind: 'resumed', newRun: { ...next.run }, observedAt: Date.now() }
      const launched = next.continuity.launchInput
      if (launched && (!launched.launchPlan || launched.launchPlan.program !== run.program ||
          launched.launchPlan.argsDigest !== createHash('sha256').update(JSON.stringify(run.args)).digest('base64url'))) {
        throw new AgentMuxError('The original resume launch arguments are unconfirmed. The original Run and input are kept.', 'CONTINUITY_OPERATION_MISMATCH')
      }
      bindContinuityLaunchInput(next.continuity, next.run)
      const recoveryDelivery = createContinuityInputDelivery(next.continuity)
      if (recoveryDelivery) next.continuity.recoveryDelivery = recoveryDelivery
      delete next.continuity.nextActionAt
      next.continuityOperations = { ...prepared.continuityOperations, [prepared.continuity.operationId]: next.continuity }
    }
    try { await this.ports.sessions.registry.commitLifecycle(reservation, next) }
    catch (error) {
      const canonical = await this.ports.sessions.store.readMetadata(prepared.agentSessionId)
      if (canonical?.run.runId !== run.runId || canonical.continuity?.operationId !== prepared.continuity?.operationId) throw error
      await this.ports.sessions.registry.load('local')
    }
    await this.restoreReopenObservation(this.ports.sessions.registry.get(next.agentSessionId), run, reservation.operationId)
    let restored = this.ports.sessions.registry.get(next.agentSessionId)
    try { restored = await this.ports.terminal.ensureTerminalHandshakeOrDegrade(restored, run) }
    catch (error) {
      if (error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED && restored.continuity) {
        const operationId = restored.continuity.operationId
        restored = await this.ports.sessions.updateExactAgentSession(restored.agentSessionId, restored.run, value => {
          const failed = { ...value.continuityOperations![operationId]!, kind: 'unavailable' as const, reason: 'process-exited', errorCode: error.code, error: error.message }
          return { ...value, continuity: failed, continuityOperations: { ...value.continuityOperations, [operationId]: failed } }
        })
        this.ports.events.publishSession(restored)
        await this.ports.events.publishCurrentRunState(restored)
      }
      throw error
    }
    const carried = prepared.continuity && restored.continuityOperations?.[prepared.continuity.operationId]?.launchInput
    if (carried?.delivery === 'post-launch' && prepared.continuity) return await this.settleContinuityPostLaunchInput(restored, prepared.continuity.operationId)
    if (carried?.delivery === 'launch' && carried.state === 'launch-carried') {
      // The exact original Start is now known, so its frozen history can be
      // recorded under the same input ID without dispatching any input again.
      await this.ports.input.recordPromptMessageAfterSideEffect(restored, carried.input.submissionId, 'Resume prompt', carried.message)
    }
    return restored
  }

  async observeResumedInterruption(session: AgentMuxStoredAgentSession): Promise<AgentMuxStoredAgentSession> {
    const active = Object.values(session.continuityOperations ?? {}).find(op => op.kind === 'resumed' && op.newRun?.runId === session.run.runId)
    if (!active || active.recoveryDelivery || active.resumedInterruption || this.reopensDisposed) return session
    const key = JSON.stringify([session.agentSessionId, session.run.runId, active.operationId])
    const existing = this.resumedInterruptionReads.get(key)
    if (existing) return await existing
    const controller = new AbortController(), epoch = this.ports.connection.connectionEpoch
    this.providerReads.add(controller)
    this.ports.observations.providerReads.add(controller)
    const pending = observeResumedTurnInterruption(session, {
      provider: this.ports.providers.providers.get(session.providerId), signal: controller.signal,
      status: async () => { const run = await this.ports.runtime.kernel.status(session.run.runId); this.ports.runtime.assertAgentRun(session, run, [session]); return run },
      save: async change => {
        if (controller.signal.aborted || epoch !== this.ports.connection.connectionEpoch || this.reopensDisposed) return session
        const updated = await this.ports.sessions.updateExactAgentSession(session.agentSessionId, session.run, change)
        if (!isDeepStrictEqual(updated.continuityOperations, session.continuityOperations)) {
          this.ports.events.publishSession(updated); this.continuityInputs.track(updated)
        }
        return updated
      }
    }).catch(error => {
      if (!controller.signal.aborted && epoch === this.ports.connection.connectionEpoch && !this.reopensDisposed) this.ports.events.publisher.publish({
        type: 'agent-error', agentSessionId: session.agentSessionId, code: 'AGENT_CONTINUITY_OBSERVATION_UNCONFIRMED',
        message: `The original recovered turn is unconfirmed. Its Session, healthy Run and ordinary input remain available. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
      return session
    }).finally(() => { this.providerReads.delete(controller); this.ports.observations.providerReads.delete(controller); if (this.resumedInterruptionReads.get(key) === pending) this.resumedInterruptionReads.delete(key) })
    this.resumedInterruptionReads.set(key, pending)
    return await pending
  }

  private async exactRecoverySession(session: AgentMuxStoredAgentSession, operationId?: string, automatic = false): Promise<AgentMuxStoredAgentSession | null> {
    const canonical = await this.ports.sessions.store.readMetadata(session.agentSessionId)
    if (!canonical || !sameRun(canonical.run, session.run) || canonical.hostId !== session.hostId ||
      canonical.providerId !== session.providerId || canonical.executorId !== session.executorId || canonical.workspacePath !== session.workspacePath ||
      canonical.capabilityHash !== session.capabilityHash || !isDeepStrictEqual(canonical.nativeActor, session.nativeActor)) throw new AgentMuxError(
      'The original recovery Run or actor changed. Existing identities and input are retained.', 'AGENT_CONTINUITY_SUPERSEDED')
    const lifecycle = await this.ports.sessions.store.readLifecycleReservation(canonical.agentSessionId)
    if (lifecycle?.kind === 'stop' && sameRun(lifecycle.expectedRun, canonical.run)) return null
    const active = operationId ? canonical.continuityOperations?.[operationId] : canonical.continuity
    if (operationId && !active) throw new AgentMuxError('The original recovery operation is unconfirmed.', 'AGENT_CONTINUITY_RECEIPT_UNCONFIRMED')
    const root = active?.intentOperationId ? canonical.continuityOperations?.[active.intentOperationId] : active
    if (root?.supervision?.phase === 'cancelled' && (!active?.initializationRecovery ||
      active.initializationRecovery.actorId === canonical.nativeActor?.actorId && sameRun(active.initializationRecovery.run, canonical.run))) return null
    if (automatic && root?.supervision?.phase === 'paused' && active?.initializationRecovery &&
      active.initializationRecovery.actorId === canonical.nativeActor?.actorId && sameRun(active.initializationRecovery.run, canonical.run) &&
      ['retry-budget-exhausted', 'frontend-retry-budget-exhausted'].includes(root.supervision.reason)) return null
    return canonical
  }

  private async recoverOriginalFrontend(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun,
    request: AgentTerminalFrontendRecoveryRequest, ownerOperationId = request.operationId): Promise<AgentTerminalFrontendObservation> {
    const controller = new AbortController()
    this.providerReads.add(controller); this.ports.observations.providerReads.add(controller)
    try {
      const assertRequest = async (): Promise<void> => {
        const exact = !this.reopensDisposed && await this.exactRecoverySession(session, ownerOperationId)
        if (!exact) throw new AgentMuxError('The original recovery was cancelled. Its backend and input are retained.', 'AGENT_CONTINUITY_SUPERSEDED')
        const operation = exact.continuityOperations?.[ownerOperationId]
        const sameTarget = request.target.kind === 'initialization'
          ? operation?.initializationRecovery?.lifecycleOperationId === request.target.lifecycleOperationId &&
            operation.initializationRecovery.previousFrontendId === request.expectedFrontendId && request.operationId === ownerOperationId
          : operation?.frontendReconnect?.previousFrontendId === request.expectedFrontendId &&
            (operation.frontendReconnect.operationId ?? ownerOperationId) === request.operationId &&
            operation.nativeTarget?.sessionId === request.target.nativeSessionId && exact.nativeHandle?.sessionId === request.target.nativeSessionId
        if (!sameTarget) throw new AgentMuxError('The original recovery action target changed. Its prior receipts are retained.', 'AGENT_CONTINUITY_SUPERSEDED')
      }
      await assertRequest()
      const provider = this.ports.providers.providers.get(session.providerId)
      const observed = await observePromptInput(controller.signal, () => provider.reconnectTerminalFrontend!({
        processId: run.pid!, nativeActor: session.nativeActor!, workspacePath: session.workspacePath, signal: controller.signal
      }, request))
      await assertRequest()
      return parseTerminalFrontendObservation(observed)
    } finally { this.providerReads.delete(controller); this.ports.observations.providerReads.delete(controller) }
  }

  private async assertRecoveryInputCurrent(session: AgentMuxStoredAgentSession, operationId?: string, automatic = false): Promise<void> {
    if (this.reopensDisposed || !await this.exactRecoverySession(session, operationId, automatic)) throw new AgentMuxError(
      'The original recovery input was cancelled before dispatch. Its key and retained input remain available.', 'AGENT_CONTINUITY_SUPERSEDED')
  }

  private async bindInitializedNativeSession(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun,
    frontend: AgentTerminalFrontendObservation): Promise<AgentMuxStoredAgentSession> {
    const actor = session.nativeActor, initialization = frontend.initialization
    if (!actor?.initializationControl || initialization?.phase !== 'ready' || initialization.native.state !== 'confirmed' ||
      initialization.lifecycleOperationId !== actor.lifecycleOperationId || run.state.type !== 'running' || run.runId !== session.run.runId) {
      throw new AgentMuxError('The original actor initialization is not confirmed. Its Session and input are retained.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
    }
    const target = { kind: 'provider' as const, providerId: session.providerId, sessionId: initialization.native.sessionId }
    const current = await this.ports.sessions.updateExactAgentSession(session.agentSessionId, session.run, value => {
      if (!isDeepStrictEqual(value.nativeActor, actor) || value.capabilityHash !== session.capabilityHash ||
        value.nativeHandle && !matchesProviderNativeSessionTarget(target, value.nativeHandle) ||
        value.observedNativeHandle && !matchesProviderNativeSessionTarget(target, value.observedNativeHandle)) throw new AgentMuxError(
        'The original initialization target changed. Existing identities and input are retained.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
      // An initialization identity does not attest a record locator or clear a
      // later source observation. Keep the richer original binding untouched.
      if (value.nativeHandle) return value
      return { ...value, nativeHandle: target, updatedAt: Math.max(value.updatedAt + 1, Date.now()) }
    })
    this.ports.events.publishSession(current)
    // The protocol confirms the original identity before a native record may be
    // available. Let its existing Provider discovery enrich that same identity;
    // a known SID must not suppress status/history observation of its own record.
    this.ports.terminal.queueNativeIdentityCapture(current)
    return current
  }

  private async acceptRecoveredFrontend(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun,
    frontend: AgentTerminalFrontendObservation, outputAfterByte: number): Promise<AgentMuxStoredAgentSession> {
    const provider = this.ports.providers.providers.get(session.providerId)
    const current = await this.ports.sessions.updateExactAgentSession(session.agentSessionId, session.run, value => {
      if (value.terminalHandshake?.frontendId === frontend.frontendId) return value
      const updated = { ...value }; delete updated.terminalHandshake; delete updated.terminalCapability; delete updated.terminalPromptReadiness
      if (provider.terminalHandshake && provider.terminalPromptRender) updated.terminalPromptReadiness = {
        source: 'initial-composer', run: { ...value.run }, outputCursorBytes: outputAfterByte,
        id: terminalInitialPromptReadinessIdentity(value, terminalHandshakeOperationIdentity(value.providerId, value.run.runId, provider.terminalHandshake, frontend.frontendId))
      }
      return updated
    })
    this.ports.terminal.screenEvidence.discard(current.agentSessionId)
    await this.ports.terminal.ensureTerminalHandshakeOrDegrade(current, run)
    return this.ports.sessions.registry.get(current.agentSessionId)
  }

  private observeInitialInput(session: AgentMuxStoredAgentSession): void {
    const input = session.initialInput
    const retained = Object.values(session.continuityOperations ?? {}).filter(operation => operation.launchInput?.delivery === 'post-launch' &&
      operation.launchInput.key?.expectedRun.runId === session.run.runId && !['native-admitted', 'terminal-confirmed', 'not-applied'].includes(operation.launchInput.state))
    const initial = input?.key?.expectedRun.runId === session.run.runId && !['native-admitted', 'terminal-confirmed', 'not-applied'].includes(input.state)
    if (this.reopensDisposed || !session.nativeActor?.initializationControl || !initial && !retained.length) return
    const key = JSON.stringify([session.agentSessionId, session.run, session.nativeActor.actorId, initial ? input?.key : null, retained.map(value => value.operationId)])
    if (this.initialInputContinuations.has(key)) return
    const work = (async () => {
      await this.ports.terminal.ensureTerminalFrontendObservation(session)
      const current = await this.ports.sessions.registry.refresh(session.agentSessionId, session.run)
      const frontend = this.ports.terminal.terminalFrontendWatches.get(session.agentSessionId)?.frontend
      if (this.reopensDisposed || !frontend || !sameRun(frontend.run, current.run) || frontend.initialization?.phase !== 'ready') return
      const run = await this.ports.runtime.requireCurrentAgentRun(current)
      const bound = await this.bindInitializedNativeSession(current, run, frontend)
      const exact = await this.exactRecoverySession(bound, undefined, true)
      if (!this.reopensDisposed && exact) {
        if (initial) await this.ports.input.continueInitialInput(exact, run, () => this.assertRecoveryInputCurrent(exact, undefined, true))
        for (const operation of retained) await this.settleContinuityPostLaunchInput(this.ports.sessions.registry.get(session.agentSessionId), operation.operationId)
      }
    })().catch(error => {
      if (!this.reopensDisposed) this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: 'AGENT_INITIAL_INPUT_UNCONFIRMED', message: `The original initialization input is retained. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
    }).finally(() => { if (this.initialInputContinuations.get(key) === work) this.initialInputContinuations.delete(key) })
    this.initialInputContinuations.set(key, work)
  }

  private async performAgentContinuity(input: AgentMuxAgentContinuityInput, intentOperationId?: string, inputContextSource?: import('../browser-input-context.js').BrowserInputContextSource, captured?: ResolvedAgentInputContextCapture): Promise<AgentMuxAgentContinuityResult> {
    // A different public Core owner may already have frozen or completed this
    // same operation. Admit only this exact current binding, never a registry catalog.
    const epoch = this.ports.connection.connectionEpoch
    let current = await this.ports.sessions.store.readMetadata(input.agentSessionId)
    const retirement = await this.ports.sessions.store.readRetiredAgentSession(input.agentSessionId)
    this.ports.connection.assertConnectionEpoch(epoch)
    this.ports.connection.requireConnected()
    if (current && retirement) throw new AgentMuxError('Session is both active and retired.', 'INVALID_AGENT_SESSION_STORE')
    if (current) {
      await this.ports.sessions.resolveRawAgentSession(input.agentSessionId)
      current = await this.ports.sessions.registry.refresh(input.agentSessionId, current.run)
      this.ports.connection.assertConnectionEpoch(epoch)
    }
    const retained = current && this.continuitySupervisor.retainedAutomaticIntent(current, input)
    if (current && retained) {
      if (retained.initializationRecovery || current.nativeActor?.initializationControl) return await this.performAgentContinuity({ agentSessionId: input.agentSessionId,
        expectedRun: { ...input.expectedRun }, operationId: retained.operationId, trigger: retained.trigger, policy: retained.policy,
        ...(retained.timingOverride ? { timingOverride: retained.timingOverride } : {}) }, retained.intentOperationId)
      this.continuitySupervisor.observe(current)
      let run: AgentMuxRun | null = null
      let evidence: import('./continuity.js').AgentMuxAgentContinuityRunEvidence = { kind: 'run-unknown', observedAt: Date.now(), message: 'Original recovery observation is pending.' }
      try {
        const observed = await this.ports.runtime.kernel.status(current.run.runId); this.ports.runtime.assertAgentRun(current, observed); run = this.ports.events.projectRun(observed, current)
        evidence = run.state === 'running' ? { kind: 'run-running', observedAt: run.observedAt }
          : { kind: 'run-ended', state: run.state as 'exited' | 'interrupted', observedAt: run.observedAt }
      } catch (error) {
        if (error instanceof AgentMuxError && error.code === 'AGENT_SESSION_RUN_MISMATCH') throw error
        evidence = { kind: 'run-unknown', observedAt: Date.now(), message: error instanceof Error ? error.message : String(error) }
      }
      if (run?.state === 'running') return { kind: 'reattachable', session: this.ports.events.projectSession(current), previousRun: { ...input.expectedRun }, run,
        evidence: { kind: 'run-running', observedAt: run.observedAt }, continuity: structuredClone(retained) }
      const root = current.continuityOperations?.[retained.intentOperationId ?? retained.operationId]
      return { kind: 'pending', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun },
        reason: root?.supervision?.phase === 'cancelled' ? 'intent-cancelled' : 'recovery-supervised', evidence,
        continuity: structuredClone(retained) }
    }
    // A restarted observer rejoins the admitted automatic intent rather than recomposing its policy or delay.
    if (current?.continuity && !current.continuityOperations?.[input.operationId] &&
      input.trigger && !['manual', 'input'].includes(input.trigger) &&
      (current.continuity.kind === 'starting' || ['active-delay', 'operation-unconfirmed'].includes(current.continuity.reason) ||
        ['runtime-unverified', 'provider-unverified'].includes(current.continuity.reason) && current.continuity.nextActionAt !== undefined) &&
      sameRun(current.continuity.previousRun, input.expectedRun)) {
      input = { ...input, operationId: current.continuity.operationId }
    }
    const prior = current?.continuityOperations?.[input.operationId]
    const originalExecutorRoot = prior?.intentOperationId ?? input.operationId
    if (current && !current.creation?.executorRevision && ['commandOverride', 'args', 'env'].some(key => input[key as 'commandOverride' | 'args' | 'env'] !== undefined)) {
      const originalExecutor = readContinuityExecutor(current.continuityExecutors, originalExecutorRoot)
      if (originalExecutor && ['commandOverride', 'args', 'env'].some(key => {
        const field = key as 'commandOverride' | 'args' | 'env'
        return input[field] !== undefined && (originalExecutor.source !== 'sdk' || !isDeepStrictEqual(input[field], originalExecutor.options[field]))
      })) throw new AgentMuxError('The original recovery execution options are frozen. Recheck the original request or authorize a separate recovery intent.',
        'AGENT_CONTINUITY_EXECUTOR_CONFLICT')
    }
    if (intentOperationId && prior?.intentOperationId !== intentOperationId) throw new AgentMuxError('The original supervised attempt changed.', 'AGENT_CONTINUITY_SUPERSEDED')
    if (input.input) {
      if (input.trigger !== 'input' || typeof input.input.prompt !== 'string' ||
          !composeAgentPrompt(input.input.prompt, input.input.agentMuxNote, prior?.launchInput?.message.inputContext ?? captured?.inputContext ?? input.input.inputContext).text.trim()) throw new AgentMuxError('A new continuity input needs its original input trigger and nonempty content.', 'INVALID_AGENT_PROMPT')
      safeId(input.input.submissionId, 'Original continuity input id')
      assertAgentPromptSize(composeAgentPrompt(input.input.prompt, input.input.agentMuxNote, prior?.launchInput?.message.inputContext ?? captured?.inputContext ?? input.input.inputContext).text)
      if (prior && (!prior.launchInput || !isDeepStrictEqual(prior.launchInput.input, input.input))) throw new AgentMuxError(
        'This original recovery operation has another frozen input. Its original body and Run are kept.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    }
    if (prior && !sameRun(prior.previousRun, input.expectedRun)) {
      throw new AgentMuxError('A continuity operation must retain its original Run.', 'CONTINUITY_OPERATION_MISMATCH')
    }
    const priorFailure = rolledBackResumeFailure(current ?? undefined, input.operationId)
    if (priorFailure) throw priorFailure
    const now = Date.now(), policy = prior?.policy ?? normalizeAgentContinuityPolicy(input.policy)
    const receipt: AgentMuxContinuityOperation = prior ? structuredClone(prior) : {
      operationId: input.operationId, agentSessionId: input.agentSessionId, trigger: input.trigger ?? 'manual',
      ...(input.timingOverride ? { timingOverride: input.timingOverride } : {}), policy,
      previousRun: { ...input.expectedRun }, admittedAt: now, observedAt: now, rechecks: 0,
      kind: 'pending', reason: 'runtime-unverified', evidence: { kind: 'run-unknown', observedAt: now, message: 'Not yet observed.' }
    }
    const executorRoot = receipt.intentOperationId ?? receipt.operationId
    let authoredExecutor: AgentContinuityExecutor | undefined
    if (current && !prior && (current.continuityExecutors === undefined || continuityExecutorEntries(current.continuityExecutors) &&
      !Object.hasOwn(continuityExecutorEntries(current.continuityExecutors)!, executorRoot))) {
      const explicit = input.commandOverride !== undefined || input.args !== undefined || input.env !== undefined
      const common = { providerId: current.providerId, executorId: current.executorId }
      authoredExecutor = !current.creation?.executorRevision && explicit
        ? { ...common, source: 'sdk', options: {
          ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride }),
          ...(input.args === undefined ? {} : { args: [...input.args] }),
          ...(input.env === undefined ? {} : { env: { ...input.env } }) } }
        : { ...common, source: current.creation?.executorRevision || this.ports.executors.hostExecutorOwner ? 'host' : 'provider' }
    }
    const retainExecutor = (value: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession => {
      if (!authoredExecutor) return value
      const entries = continuityExecutorEntries(value.continuityExecutors)
      if (value.continuityExecutors !== undefined && !entries) throw unconfirmedContinuityExecutor()
      const frozen = entries?.[executorRoot]
      if (frozen && !isDeepStrictEqual(frozen, authoredExecutor)) throw new AgentMuxError(
        'The original recovery operation has another execution source. Keep its original operation and input.', 'AGENT_CONTINUITY_EXECUTOR_CONFLICT')
      return { ...value, continuityExecutors: { ...entries, [executorRoot]: frozen ?? authoredExecutor } }
    }
    // Freeze a new authored input even when Runtime/provider observation has not
    // succeeded yet. A retry reads this same request rather than inventing one.
    if (!prior && input.input && current) receipt.launchInput = prepareContinuityLaunchInput(receipt,
      this.ports.providers.providers.get(current.providerId).catalog, agentLifecycleOperationIdentity('resume', input.agentSessionId, input.operationId), input.input, inputContextSource, captured)!
    receipt.observedAt = now
    delete receipt.nextActionAt
    const originalLaunch = (value: AgentMuxStoredAgentSession) => {
      const saved = value.continuityOperations?.[receipt.operationId]?.launchInput
      if (saved && receipt.launchInput && !isDeepStrictEqual(saved.input, receipt.launchInput.input)) throw new AgentMuxError(
        'This original recovery input already has another frozen body or source.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      return saved && (['launch-carried', 'terminal-confirmed', 'native-admitted', 'not-applied'].includes(saved.state) ||
        receipt.launchInput?.state === 'prepared' && saved.state !== 'prepared') ? saved : receipt.launchInput ?? saved
    }
    const resumedFacts = (value: AgentMuxStoredAgentSession) => {
      const saved = value.continuityOperations?.[receipt.operationId]
      return { ...(saved?.resumedInputBoundary ? { resumedInputBoundary: saved.resumedInputBoundary } : {}),
        ...(saved?.resumedInterruption ? { resumedInterruption: saved.resumedInterruption,
          interruptedWorking: saved.interruptedWorking, ...(saved.recoveryInputs ? { recoveryInputs: saved.recoveryInputs } : {}) } : {}) }
    }
    const record = async (result: AgentMuxAgentContinuityResult, reason?: string): Promise<AgentMuxAgentContinuityResult> => {
      receipt.kind = result.kind
      receipt.reason = reason ?? ('reason' in result ? result.reason : result.kind)
      receipt.evidence = result.evidence.kind === 'provider-native' ? result.evidence.previousRun : result.evidence
      if (result.kind === 'conflict' && receipt.launchInput?.state === 'prepared' &&
          (!prior || prior.kind === 'pending' && ['runtime-unverified', 'provider-unverified'].includes(prior.reason))) {
        // This intent never attempted Start. A different operation's lease/Run
        // cannot claim that it carried this input; unknown starts stay unknown.
        receipt.launchInput.state = 'not-applied'
      }
      if (result.kind === 'resumed') receipt.newRun = { ...result.run }
      if (result.kind === 'pending' && result.nextActionAt !== undefined) receipt.nextActionAt = result.nextActionAt
      if (result.kind === 'pending' && current && !receipt.intentOperationId && !receipt.supervision && !['manual', 'input'].includes(receipt.trigger)) {
        if (current.nativeHandle?.kind === 'provider' && current.nativeHandle.providerId === current.providerId) receipt.nativeTarget = structuredClone(current.nativeHandle)
        receipt.supervision = { phase: result.nextActionAt === undefined ? 'paused' : 'observing', activeAttemptOperationId: receipt.operationId,
          attemptCount: 0, attemptLimit: Math.min(Number.MAX_SAFE_INTEGER, 1 + policy.retryMaxAttempts), observedAt: now, reason: result.reason }
      }
      if (result.kind === 'reattachable' && receipt.supervision?.attemptCount === 0) {
        receipt.supervision = { ...receipt.supervision, phase: 'settled', reason: 'original-run-reattached', observedAt: now }
        delete receipt.supervision.nextAttemptAt
      }
      if (current) {
        try {
          current = await this.ports.sessions.updateExactAgentSession(current.agentSessionId, current.run, value => {
            const latest = value.continuityOperations?.[receipt.operationId]
            if (latest?.supervision?.phase === 'cancelled' && latest.supervision.attemptCount === 0) return value
            // A competing observer cannot demote the same admitted or bound Start to its local
            // lifecycle-busy result. The durable original operation remains the reconciliation owner.
            if (latest?.supervision && ((latest.kind === 'starting' && result.kind === 'conflict') ||
                latest.newRun && sameRun(latest.newRun, value.run) && !receipt.newRun)) return value
            return { ...retainExecutor(value),
            continuity: { ...structuredClone(receipt), ...resumedFacts(value), ...(value.continuityOperations?.[receipt.operationId]?.recoveryDelivery
              ? { recoveryDelivery: value.continuityOperations[receipt.operationId]!.recoveryDelivery! } : {}),
              ...(originalLaunch(value) ? { launchInput: originalLaunch(value)! } : {}),
              ...(value.continuityOperations?.[receipt.operationId]?.supervision ? { supervision: value.continuityOperations[receipt.operationId]!.supervision! } : {}) },
            continuityOperations: { ...value.continuityOperations, [receipt.operationId]: { ...structuredClone(receipt), ...resumedFacts(value),
              ...(value.continuityOperations?.[receipt.operationId]?.recoveryDelivery ? { recoveryDelivery: value.continuityOperations[receipt.operationId]!.recoveryDelivery! } : {}),
              ...(originalLaunch(value) ? { launchInput: originalLaunch(value)! } : {}),
              ...(value.continuityOperations?.[receipt.operationId]?.supervision ? { supervision: value.continuityOperations[receipt.operationId]!.supervision! } : {}) } } }
          })
          this.ports.events.publishSession(current)
        } catch (error) {
          if (error instanceof AgentMuxError && ['AGENT_PROMPT_OPERATION_CONFLICT', 'AGENT_CONTINUITY_EXECUTOR_CONFLICT'].includes(error.code)) throw error
          receipt.error = `Continuity receipt persistence is unconfirmed. ${error instanceof Error ? error.message : String(error)}`
          this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: input.agentSessionId, code: 'AGENT_CONTINUITY_RECEIPT_UNCONFIRMED',
            message: receipt.error, evidence: { source: 'agentmux', run: input.expectedRun, observedAt: now } })
        }
      }
      const cancelledWaiting = current?.continuityOperations?.[receipt.operationId]
      if (cancelledWaiting?.supervision?.phase === 'cancelled' && cancelledWaiting.supervision.attemptCount === 0) {
        return { kind: 'pending', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun }, reason: 'intent-cancelled',
          evidence: result.evidence.kind === 'provider-native' ? result.evidence.previousRun : { kind: 'run-unknown', observedAt: now, message: 'The original waiting recovery was cancelled.' },
          continuity: structuredClone(cancelledWaiting) }
      }
      if (current?.continuityOperations?.[receipt.operationId]?.recoveryDelivery) receipt.recoveryDelivery = structuredClone(current.continuityOperations[receipt.operationId]!.recoveryDelivery!)
      if (current?.continuityOperations?.[receipt.operationId]?.launchInput) receipt.launchInput = structuredClone(current.continuityOperations[receipt.operationId]!.launchInput!)
      if (current?.continuityOperations?.[receipt.operationId]?.supervision) receipt.supervision = structuredClone(current.continuityOperations[receipt.operationId]!.supervision!)
      if (current) Object.assign(receipt, structuredClone(resumedFacts(current)))
      this.continuitySupervisor.schedule(input, receipt)
      return { ...result, ...((result.kind === 'resumed' || result.kind === 'reattachable') && current ? { session: this.ports.events.projectSession(current) } : {}), continuity: structuredClone(receipt) }
    }
    const recordKnownSupervisedStart = async (error: unknown): Promise<AgentMuxAgentContinuityResult | null> => {
      if (!receipt.supervision && !receipt.intentOperationId) return null
      const canonical = await this.ports.sessions.store.readMetadata(input.agentSessionId), known = canonical?.continuityOperations?.[input.operationId]
      if (!canonical || !known?.newRun || !sameRun(known.newRun, canonical.run)) return null
      current = canonical
      receipt.newRun = { ...known.newRun }
      if (error instanceof AgentMuxError) receipt.errorCode = error.code
      receipt.error = error instanceof Error ? error.message : String(error)
      return await record({ kind: 'resumed', session: this.ports.events.projectSession(canonical), previousRun: receipt.previousRun, run: known.newRun,
        evidence: { kind: 'provider-native', providerId: canonical.providerId, nativeSessionId: canonical.nativeHandle!.sessionId,
          previousRun: receipt.evidence as import('./continuity.js').AgentMuxAgentContinuityRunEvidence } }, receipt.reason)
    }
    const pending = (reason: import('./continuity.js').AgentMuxContinuityPendingReason,
      evidence: import('./continuity.js').AgentMuxAgentContinuityRunEvidence, nextActionAt?: number) => record({
        kind: 'pending', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun }, reason, evidence,
        ...(nextActionAt === undefined ? {} : { nextActionAt }) })
    if (current && !sameRun(current.run, input.expectedRun)) {
      if (prior?.newRun && sameRun(prior.newRun, current.run) && prior.kind === 'resumed') {
        if (prior.launchInput?.delivery === 'post-launch' && !['terminal-confirmed', 'native-admitted'].includes(prior.launchInput.state)) {
          current = await this.settleContinuityPostLaunchInput(current, input.operationId)
        }
        return record({ kind: 'resumed', session: this.ports.events.projectSession(current), previousRun: { ...input.expectedRun }, run: { ...current.run },
          evidence: { kind: 'provider-native', providerId: current.providerId,
            nativeSessionId: current.nativeHandle?.sessionId ?? '', previousRun: prior.evidence as import('./continuity.js').AgentMuxAgentContinuityRunEvidence } }, prior.reason)
      }
      return record({ kind: 'conflict', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun },
        currentRun: { ...current.run }, reason: 'session-run-changed', evidence: { kind: 'agent-session-store' } })
    }
    if (prior?.supervision?.phase === 'cancelled' && prior.supervision.attemptCount === 0) {
      return { kind: 'pending', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun }, reason: 'intent-cancelled',
        evidence: { kind: 'run-unknown', observedAt: now, message: 'The original waiting recovery was explicitly cancelled.' }, continuity: structuredClone(prior) }
    }
    let run: AgentMuxRun | null = null
    if (current) {
      try { const observed = await this.ports.runtime.kernel.status(current.run.runId); this.ports.runtime.assertAgentRun(current, observed); run = this.ports.events.projectRun(observed, current) }
      catch (error) {
        if (error instanceof AgentMuxError && error.code === 'AGENT_SESSION_RUN_MISMATCH') return record({
          kind: 'conflict', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun },
          reason: 'session-run-changed', evidence: { kind: 'agent-session-store' } })
        if (!(error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found')) {
          if (prior) receipt.rechecks++
          const next = receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined
          return pending('runtime-unverified', { kind: 'run-unknown', observedAt: now, message: error instanceof Error ? error.message : String(error) }, next)
        }
      }
    }
    const evidence = run?.state === 'running' ? { kind: 'run-running' as const, observedAt: run.observedAt }
      : run ? { kind: 'run-ended' as const, state: run.state as 'exited' | 'interrupted', observedAt: run.observedAt }
      : { kind: 'run-missing' as const, observedAt: now }
    const catalog = current ? this.ports.providers.providers.get(current.providerId).catalog : null
    let admission: ReturnType<typeof agentContinuityAdmission> | undefined
    if (current && run?.state !== 'running') {
      if (prior?.kind === 'reattachable' && prior.frontendReconnect?.frontendId) throw new AgentMuxError(
        'The original frontend reconnection completed. This ended Run needs a new explicit recovery operation.', 'AGENT_CONTINUITY_SUPERSEDED', undefined,
        { disposition: 'not_applied', confirmedInputBytes: null })
      // A prior start with no receipt is observation-only. Never dispatch another start or old input.
      if (!prior?.frontendReconnect && !prior?.initializationRecovery && (prior?.kind === 'starting' || prior?.reason === 'operation-unconfirmed')) {
        const lifecycleId = agentLifecycleOperationIdentity('resume', input.agentSessionId, input.operationId)
        try {
          const reservation = await this.ports.sessions.store.loadResumeCorrelation(input.agentSessionId, lifecycleId)
          if (reservation?.preparedSession) {
            const recovered = await this.completePreparedResume(reservation, await this.ports.runtime.kernel.list())
            if (recovered) { current = this.ports.sessions.registry.get(input.agentSessionId); return record({ kind: 'resumed', session: this.ports.events.projectSession(current),
              previousRun: { ...input.expectedRun }, run: { ...current.run }, evidence: { kind: 'provider-native', providerId: current.providerId,
                nativeSessionId: current.nativeHandle!.sessionId, previousRun: evidence } }, recovered.continuity?.reason ?? prior.reason) }
          }
        } catch (error) {
          const known = await recordKnownSupervisedStart(error)
          if (known) return known
          receipt.error = error instanceof Error ? error.message : String(error)
        }
        if (prior) receipt.rechecks++
        return pending('operation-unconfirmed', evidence,
          receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined)
      }
      if (receipt.intentOperationId) {
        const root = current.continuityOperations?.[receipt.intentOperationId]
        if (!root?.supervision || root.supervision.activeAttemptOperationId !== receipt.operationId ||
          ['cancelled', 'settled', 'paused'].includes(root.supervision.phase) || !matchesProviderNativeSessionTarget(root.nativeTarget, current.nativeHandle)) {
          throw new AgentMuxError('The original recovery intent no longer authorizes this attempt.', 'AGENT_CONTINUITY_SUPERSEDED')
        }
        admission = { kind: 'resume', reason: 'supervised-retry', interruptedWorking: false }
      } else admission = agentContinuityAdmission({ session: this.ports.events.projectSession(current), trigger: receipt.trigger, policy,
        admittedAt: receipt.admittedAt, now, ...(receipt.timingOverride ? { timingOverride: receipt.timingOverride } : {}),
        ...(current.recoveryActivity?.run.runId === current.run.runId && current.recoveryActivity.state !== 'unknown' &&
          current.nativeHandle?.kind === 'provider' && current.recoveryActivity.nativeSessionId === current.nativeHandle.sessionId
          ? { lastActivityAt: current.recoveryActivity.observedAt } : {}) })
      if (admission.kind === 'pending') return pending(admission.reason, evidence, admission.nextActionAt)
    }
    const handle = current?.nativeHandle
    const canProbe = run?.state !== 'running' && catalog?.resumeStrategy.kind === 'provider-native' &&
      handle?.kind === 'provider' && handle.providerId === current?.providerId &&
      (catalog.resumeStrategy.locator !== 'transcript-path' || Boolean(handle.transcriptPath))
    let capability: AgentCapabilitySnapshot | null = null
    let capabilityContext: { workspacePath: string; env: Record<string, string> } | undefined
    let launchExecutable: string | undefined
    if (canProbe && current) {
      try {
        receipt.evidence = evidence
        receipt.nativeTarget = structuredClone(handle!)
        // All attempts share only the root's private logical invocation source.
        // Generated Hook credentials and the first input remain attempt-owned.
        // Current target-owned configuration is independently authoritative. A bad
        // private record must not close that original Host owner's recovery path.
        const executor = current.creation?.executorRevision && this.ports.executors.hostExecutorOwner
          ? { providerId: current.providerId, executorId: current.executorId, source: 'host' as const }
          : readContinuityExecutor(current.continuityExecutors, executorRoot) ?? authoredExecutor
        if (!executor || executor.providerId !== current.providerId || executor.executorId !== current.executorId) throw unconfirmedContinuityExecutor()
        const { commandOverride: _command, args: _args, env: _env, ...rest } = input
        const originalInput: AgentMuxAgentContinuityInput = rest
        if (current.creation?.executorRevision || executor.source === 'host') {
          if (!this.ports.executors.hostExecutorOwner) throw unconfirmedContinuityExecutor()
          input = await this.ports.executors.sessionExecutorOptions(current, originalInput)
        } else input = executor.source === 'sdk' ? { ...originalInput, ...structuredClone(executor.options) } : originalInput
        const oldInput = current?.promptCompletionAdmission
        receipt.previousInput = { scope: 'typed-prompt', outcome: !oldInput ? 'none' : current && agentPromptNotApplied(current) ? 'not-applied'
          : oldInput.acknowledged ? oldInput.transport === 'native' ? oldInput.native.outcome === 'admitted' ? 'native-admitted' : 'unknown' : 'terminal-confirmed' : 'unknown',
          ...(oldInput?.inputKey ? { key: structuredClone(oldInput.inputKey) } : {}) }
        // Restore the original conversation independently of any new automatic input.
        // Freeze old-writer evidence before resume can create an initial-idle predecessor.
        if (!receipt.interruption && !receipt.intentOperationId) receipt.interruption = await inspectAgentSessionInterruption(current,
          this.ports.providers.providers.get(current.providerId), policy, [])
        receipt.interruptedWorking = !receipt.intentOperationId && receipt.interruption?.state === 'interrupted'
        if (!prior?.recoveryInputs) receipt.recoveryInputs = { reminder: '',
          continuation: receipt.trigger !== 'input' && receipt.interruptedWorking && policy.continuationEnabled ? DEFAULT_AGENT_CONTINUITY_CONTINUATION : '' }
        const launchInput = prior?.launchInput ?? prepareContinuityLaunchInput(receipt, catalog!,
          agentLifecycleOperationIdentity('resume', input.agentSessionId, input.operationId), input.input, inputContextSource, captured)
        if (launchInput) receipt.launchInput = launchInput
        const originalPrompt = receipt.launchInput?.prompt ?? ''
        const { plan } = this.buildResumePlan(current, input, originalPrompt || undefined)
        launchExecutable = plan.command
        capabilityContext = { workspacePath: current.workspacePath, env: terminalEnvironment(plan.env) }
        capability = await this.ports.providers.probeAgent(current.providerId, plan.command, capabilityContext)
      } catch (error) {
        receipt.error = error instanceof Error ? error.message : String(error)
        if (error instanceof AgentMuxError) receipt.errorCode = error.code
        if (prior) receipt.rechecks++
        return pending('provider-unverified', evidence, receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined)
      }
    }
    const decision = decideAgentSessionContinuity({ agentSessionId: input.agentSessionId,
      hostId: current?.hostId ?? retirement?.hostId ?? 'local', expectedRun: input.expectedRun, observedAt: now,
      session: current ? this.ports.events.projectSession(current) : null, retirement: retirement ? structuredClone(retirement) : null,
      run, catalog, capability, ...(launchExecutable === undefined ? {} : { launchExecutable }) })
    if (decision.kind === 'reattachable' && current) {
      const provider = this.ports.providers.providers.get(current.providerId)
      await this.ports.terminal.ensureTerminalFrontendObservation(current)
      const frontend = this.ports.terminal.terminalFrontendWatches.get(current.agentSessionId)?.frontend
      const initialization = frontend && sameRun(frontend.run, current.run) ? frontend.initialization : undefined
      const initializedTarget = initialization?.phase === 'ready' && initialization.native.state === 'confirmed' &&
        current.nativeHandle?.kind === 'provider' && current.nativeHandle.providerId === current.providerId &&
        current.nativeHandle.sessionId === initialization.native.sessionId
      if (receipt.initializationRecovery || initialization && !initializedTarget || current.nativeActor?.initializationControl && !initializedTarget) {
        try {
          const actor = current.nativeActor, original = receipt.initializationRecovery
          if (!actor?.initializationControl || !provider.reconnectTerminalFrontend || !run?.pid ||
            original && (original.actorId !== actor.actorId || original.lifecycleOperationId !== actor.lifecycleOperationId || !sameRun(original.run, current.run)) ||
            initialization && initialization.lifecycleOperationId !== actor.lifecycleOperationId) throw new AgentMuxError(
            'The original initialization control or lifecycle is unconfirmed. The backend and input are retained.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
          const exact = await this.exactRecoverySession(current)
          if (!exact) return pending('intent-cancelled', evidence)
          current = exact
          if (!original && (!frontend || !initialization)) return pending('provider-unverified', evidence)
          receipt.initializationRecovery ??= { actorId: actor.actorId, lifecycleOperationId: actor.lifecycleOperationId, run: { ...current.run },
            previousFrontendId: frontend!.frontendId, outputAfterByte: run.latestOutputBytes,
            observation: parseTerminalFrontendObservation((({ run: _run, ...value }) => value)(frontend!)) }
          let next = initialization ? receipt.initializationRecovery.observation = parseTerminalFrontendObservation(
            (({ run: _run, ...value }) => value)(frontend!)) : receipt.initializationRecovery.observation
          if (!initialization || next.initialization?.phase !== 'ready') {
            const explicit = input.trigger === 'manual' || input.trigger === 'input'
            if (!explicit && policy.activeRecovery === 'manual') return pending('active-manual', evidence)
            if (!explicit && prior?.supervision?.phase === 'paused' && prior.rechecks >= policy.recheckMaxAttempts &&
              next.initialization?.phase === 'failed') return pending('provider-unverified', evidence)
            // This invokes only the original actor reconciler. The Provider owns
            // whether its preflight was not applied or its native promise must be joined.
            const admitted = await pending('operation-unconfirmed', evidence)
            if (admitted.kind === 'pending' && admitted.reason === 'intent-cancelled') return admitted
            const runtime = await this.ports.runtime.requireCurrentAgentRun(current)
            if (runtime.state.type !== 'running' || !runtime.pid) return pending('runtime-unverified', evidence)
            next = await this.recoverOriginalFrontend(current, runtime, { operationId: receipt.operationId,
              expectedFrontendId: receipt.initializationRecovery.previousFrontendId,
              target: { kind: 'initialization', lifecycleOperationId: receipt.initializationRecovery.lifecycleOperationId } })
            if (next.initialization?.lifecycleOperationId !== actor.lifecycleOperationId) throw new AgentMuxError(
              'The Provider initialization reply belongs to another original lifecycle.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
            receipt.initializationRecovery.observation = next
          }
          if (next.initialization?.phase !== 'ready' || next.initialization.native.state !== 'confirmed') {
            receipt.rechecks++
            if (next.initialization?.failure) {
              receipt.error = next.initialization.failure.message
              if (next.initialization.failure.code !== undefined) receipt.errorCode = String(next.initialization.failure.code)
            }
            return pending(next.initialization?.phase === 'failed' ? 'provider-unverified' : 'operation-unconfirmed', evidence,
              receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined)
          }
          const observed = await pending('operation-unconfirmed', evidence)
          if (observed.kind === 'pending' && observed.reason === 'intent-cancelled') return observed
          const runtime = await this.ports.runtime.requireCurrentAgentRun(current)
          const exactReady = await this.exactRecoverySession(current, receipt.operationId)
          if (!exactReady) return pending('intent-cancelled', evidence)
          current = await this.bindInitializedNativeSession(exactReady, runtime, next)
          receipt.nativeTarget = structuredClone(current.nativeHandle as NonNullable<AgentMuxContinuityOperation['nativeTarget']>)
          const dispatch = await this.exactRecoverySession(current, receipt.operationId)
          if (!dispatch) return pending('intent-cancelled', evidence)
          current = await this.ports.input.continueInitialInput(dispatch, runtime, () => this.assertRecoveryInputCurrent(dispatch, receipt.operationId))
          for (const operation of Object.values(current.continuityOperations ?? {})) if (operation.launchInput?.key?.expectedRun.runId === current.run.runId &&
            operation.launchInput.delivery === 'post-launch') current = await this.settleContinuityPostLaunchInput(current, operation.operationId)
          if (next.state === 'attached') {
            current = await this.acceptRecoveredFrontend(current, runtime, next, receipt.initializationRecovery.outputAfterByte)
            delete receipt.error; delete receipt.errorCode
            return record({ ...decision, session: this.ports.events.projectSession(current) }, 'initialization-ready')
          }
          if (next.state !== 'detached' || next.backendState !== 'running') return pending('operation-unconfirmed', evidence,
            receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined)
          if (prior?.kind === 'reattachable' && prior.reason === 'initialization-ready' && !receipt.frontendReconnect) throw new AgentMuxError(
            'The original initialization already completed. A later frontend exit needs a new explicit recovery operation.', 'AGENT_CONTINUITY_SUPERSEDED')
          receipt.frontendReconnect ??= { previousFrontendId: next.frontendId, outputAfterByte: runtime.latestOutputBytes,
            operationId: 'initial-frontend-' + createHash('sha256').update(JSON.stringify([receipt.operationId, actor.actorId,
              actor.lifecycleOperationId, current.run, next.frontendId, current.nativeHandle])).digest('base64url') }
          const frontendAdmission = await pending('operation-unconfirmed', evidence)
          if (frontendAdmission.kind === 'pending' && frontendAdmission.reason === 'intent-cancelled') return frontendAdmission
        } catch (error) {
          receipt.error = error instanceof Error ? error.message : String(error)
          receipt.errorCode = error instanceof AgentMuxError ? error.code : 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED'
          receipt.rechecks++
          return pending('operation-unconfirmed', evidence,
            receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined)
        }
      }
      const automaticFrontend = !['manual', 'input'].includes(receipt.trigger) && frontend && sameRun(frontend.run, current.run) &&
        frontend.state === 'detached' && frontend.backendState === 'running' && typeof frontend.exitCode === 'number' && frontend.exitCode !== 0
      if (current.nativeActor?.frontendControl && provider.reconnectTerminalFrontend && (receipt.trigger === 'manual' || receipt.frontendReconnect) &&
        !receipt.frontendReconnect && (!frontend || frontend.state === 'unknown')) return pending('provider-unverified', evidence)
      if (current.nativeActor?.frontendControl && provider.reconnectTerminalFrontend &&
        ((receipt.trigger === 'manual' || automaticFrontend) && frontend?.state === 'detached' || receipt.frontendReconnect)) {
        if (automaticFrontend && !receipt.frontendReconnect) {
          const lifecycle = await this.ports.sessions.store.readLifecycleReservation(current.agentSessionId)
          if (lifecycle?.kind === 'stop' && sameRun(lifecycle.expectedRun, current.run)) return pending('intent-cancelled', evidence)
        }
        try {
          const target = current.nativeHandle
          if (target?.kind !== 'provider' || target.providerId !== current.providerId || !run?.pid) throw new AgentMuxError(
            'The exact original native thread is not confirmed. The backend and retained Session remain available.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
          if (!receipt.frontendReconnect) receipt.nativeTarget = structuredClone(target)
          else if (!matchesProviderNativeSessionTarget(receipt.nativeTarget, target)) throw new AgentMuxError(
            'The original frontend recovery native target changed. Its original operation and input are retained.', 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
          if (automaticFrontend && !receipt.supervision && !receipt.intentOperationId) receipt.supervision = {
            phase: 'observing', activeAttemptOperationId: receipt.operationId, attemptCount: 1,
            attemptLimit: Math.min(Number.MAX_SAFE_INTEGER, 1 + policy.retryMaxAttempts), observedAt: now, reason: 'frontend-reconnect-pending' }
          receipt.frontendReconnect ??= { previousFrontendId: frontend!.frontendId, outputAfterByte: run.latestOutputBytes }
          // Persist original operation/target/boundary before the frontend side effect.
          await pending('operation-unconfirmed', evidence)
          const observed = await this.recoverOriginalFrontend(current, await this.ports.runtime.requireCurrentAgentRun(current), {
            operationId: receipt.frontendReconnect.operationId ?? input.operationId,
            expectedFrontendId: receipt.frontendReconnect.previousFrontendId, target: { kind: 'native-session', nativeSessionId: target.sessionId } }, receipt.operationId)
          const next = parseTerminalFrontendObservation(observed)
          receipt.frontendReconnect.frontendId = next.frontendId
          await pending('operation-unconfirmed', evidence)
          current = await this.acceptRecoveredFrontend(current, await this.ports.runtime.requireCurrentAgentRun(current), next, receipt.frontendReconnect.outputAfterByte)
          return record({ ...decision, session: this.ports.events.projectSession(current) }, 'frontend-reconnected')
        } catch (error) {
          receipt.error = error instanceof Error ? error.message : String(error)
          receipt.errorCode = error instanceof AgentMuxError ? error.code : 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED'
          if (prior) receipt.rechecks++
          return pending('operation-unconfirmed', evidence, receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined)
        }
      }
    }
    if (decision.kind === 'reattachable' && current && input.env !== undefined) {
      void this.ports.hooks.ensureManagedHooks(this.ports.providers.providers.get(current.providerId), current.workspacePath, current.agentSessionId,
        input.env, this.ports.hooks.hookBindings.get(current.run.runId)?.endpoint).catch(error => {
        if (epoch !== this.ports.connection.connectionEpoch || this.reopensDisposed) return
        receipt.error = `Managed Hook restoration is unconfirmed. The original running Agent remains available. ${error instanceof Error ? error.message : String(error)}`
        this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: input.agentSessionId, code: 'AGENT_CONTINUITY_HOOK_UNCONFIRMED',
          message: receipt.error, evidence: { source: 'agentmux', run: input.expectedRun, observedAt: now } })
      })
    }
    if (decision.kind !== 'resume') return record(decision)
    if (receipt.supervision?.phase === 'settled' && receipt.supervision.attemptCount === 0) throw new AgentMuxError(
      'The original attachment intent is complete. A new recovery needs its own explicit operation.', 'AGENT_CONTINUITY_SUPERSEDED', undefined,
      { disposition: 'not_applied', confirmedInputBytes: null })
    try { await this.ports.hooks.requireHookIngressOwner() }
    catch (error) {
      if (error instanceof AgentMuxError && error.code === 'HOOK_INGRESS_BUSY') return record({ kind: 'conflict', agentSessionId: input.agentSessionId,
        previousRun: { ...input.expectedRun }, reason: 'lifecycle-busy', evidence: { kind: 'hook-ingress-owner' } })
      throw error
    }
    receipt.kind = 'starting'; receipt.reason = admission?.kind === 'resume' ? admission.reason : 'explicit-request'; receipt.evidence = evidence
    if (!receipt.intentOperationId && !['manual', 'input'].includes(receipt.trigger) && (!receipt.supervision || receipt.supervision.attemptCount === 0)) receipt.supervision = {
      ...receipt.supervision, phase: 'observing', activeAttemptOperationId: receipt.operationId, attemptCount: 1,
      attemptLimit: receipt.supervision?.attemptLimit ?? Math.min(Number.MAX_SAFE_INTEGER, 1 + policy.retryMaxAttempts), observedAt: now, reason: 'start-pending' }
    // Persist admission before the first irreversible start. This does not acquire a lifecycle lease.
    current = await this.ports.sessions.updateExactAgentSession(input.agentSessionId, input.expectedRun, value => {
      if (value.continuityOperations?.[receipt.operationId]?.supervision?.phase === 'cancelled') throw new AgentMuxError(
        'The original waiting recovery was cancelled before its first Start was admitted.', 'AGENT_CONTINUITY_SUPERSEDED', undefined,
        { disposition: 'not_applied', confirmedInputBytes: null })
      const frozen = value.continuityOperations?.[receipt.operationId]?.launchInput
      if (frozen && receipt.launchInput && !isDeepStrictEqual(frozen.input, receipt.launchInput.input)) throw new AgentMuxError(
        'The original recovery input was already frozen with another body or source.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      return { ...retainExecutor(value), continuity: structuredClone(receipt),
        continuityOperations: { ...value.continuityOperations, [receipt.operationId]: structuredClone(receipt) } }
    })
    try {
      const session = await this.resumeAgentRun({ agentSessionId: input.agentSessionId, operationId: input.operationId,
        ...(input.args === undefined ? {} : { args: input.args }), ...(input.env === undefined ? {} : { env: input.env }),
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride }),
        ...(input.cols === undefined ? {} : { cols: input.cols }), ...(input.rows === undefined ? {} : { rows: input.rows }),
        ...(receipt.launchInput ? { prompt: receipt.launchInput.input.prompt,
          ...(receipt.launchInput.input.agentMuxNote === undefined ? {} : { agentMuxNote: receipt.launchInput.input.agentMuxNote }) } : {})
      }, input.expectedRun, capability && capabilityContext ? { snapshot: capability, context: capabilityContext } : undefined)
      current = await this.observeResumedInterruption(this.ports.sessions.registry.get(input.agentSessionId))
      // Re-read the accepted attempt so record cannot overwrite its separately observed evidence.
      const completed = current.continuityOperations?.[receipt.operationId]
      if (completed) Object.assign(receipt, structuredClone(completed))
      return record({ kind: 'resumed', session: this.ports.events.projectSession(current), previousRun: { ...input.expectedRun }, run: { ...session.run },
        evidence: { kind: 'provider-native', providerId: decision.nativeHandle.providerId,
          nativeSessionId: decision.nativeHandle.sessionId, previousRun: decision.evidence } }, receipt.reason)
    } catch (error) {
      const known = await recordKnownSupervisedStart(error)
      if (known) return known
      try { current = this.ports.sessions.registry.get(input.agentSessionId) } catch {}
      const failure = rolledBackResumeFailure(current ?? undefined, input.operationId)
      if (failure) {
        failure.cause = error
        throw failure
      }
      if (error instanceof AgentMuxError && ['AGENT_SESSION_BUSY', 'STALE_AGENT_SESSION', 'UNKNOWN_AGENT_SESSION'].includes(error.code)) {
        const retired = await this.ports.sessions.store.readRetiredAgentSession(input.agentSessionId)
        this.ports.connection.assertConnectionEpoch(epoch)
        if (retired?.hostId === 'local' && sameRun(retired.run, input.expectedRun)) return record({ kind: 'retired', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun },
          evidence: { kind: 'user-retired', observedAt: retired.observedAt } })
        return record({ kind: 'conflict', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun },
          reason: 'lifecycle-busy', evidence: { kind: 'agent-session-store' } })
      }
      receipt.error = error instanceof Error ? error.message : String(error)
      if (receipt.launchInput?.state === 'prepared') receipt.launchInput.state = error instanceof AgentMuxError && error.controlFailure?.disposition === 'not_applied' ? 'not-applied' : 'unknown'
      return pending('operation-unconfirmed', evidence, policy.recheckMaxAttempts > 0 ? now + policy.recheckIntervalMs : undefined)
    }
  }

  private async settleContinuityPostLaunchInput(session: AgentMuxStoredAgentSession, operationId: string): Promise<AgentMuxStoredAgentSession> {
    const input = session.continuityOperations?.[operationId]?.launchInput
    if (!input?.key || input.delivery !== 'post-launch' || ['terminal-confirmed', 'native-admitted', 'not-applied'].includes(input.state)) return session
    const run = await this.ports.runtime.requireCurrentAgentRun(session)
    let nativeSource: { providerId: string; nativeSessionId: string } | undefined
    if (session.nativeActor?.initializationControl) {
      await this.ports.terminal.ensureTerminalFrontendObservation(session)
      const frontend = this.ports.terminal.terminalFrontendWatches.get(session.agentSessionId)?.frontend, initialization = frontend?.initialization
      if (!frontend || !sameRun(frontend.run, session.run) || initialization?.phase !== 'ready' || initialization.native.state !== 'confirmed' ||
        initialization.lifecycleOperationId !== input.lifecycleOperationId || session.nativeHandle?.kind !== 'provider' ||
        session.nativeHandle.providerId !== session.providerId || session.nativeHandle.sessionId !== initialization.native.sessionId) return session
      nativeSource = { providerId: session.providerId, nativeSessionId: initialization.native.sessionId }
    }
    const exact = await this.exactRecoverySession(session, operationId)
    if (!exact) return session
    let original = await this.ports.input.inspectAgentPromptSubmission(input.key)
    if (!original && input.state === 'prepared' && run.state.type === 'running') {
      await this.ports.input.deliverPostLaunchPrompt(this.ports.providers.providers.get(session.providerId),
        exact, run, input.lifecycleOperationId, input.prompt, input.message, input.input.submissionId, nativeSource,
        () => this.assertRecoveryInputCurrent(exact, operationId))
      original = await this.ports.input.inspectAgentPromptSubmission(input.key)
    }
    // No claim is no dispatch evidence. An old unknown plan never creates one.
    if (!original) return session
    let state: 'terminal-confirmed' | 'native-admitted' | 'not-applied' | 'unknown' = 'unknown'
    const claim = original.admission
    if (claim?.intent && isDeepStrictEqual(claim.inputKey, input.key) &&
        sameRun(original.run, input.key.expectedRun) && claim.intent.prompt === input.prompt && isDeepStrictEqual(claim.intent.message, input.message)) {
        if (claim.acknowledged && claim.transport === 'native' && claim.native.outcome === 'admitted') state = 'native-admitted'
        else if (claim.acknowledged && claim.transport !== 'native') state = 'terminal-confirmed'
        else if (agentPromptNotApplied({ run: original.run, promptCompletionAdmission: claim,
          ...(original.terminalPromptSubmission ? { terminalPromptSubmission: original.terminalPromptSubmission } : {}) })) state = 'not-applied'
    }
    const settled = await this.ports.sessions.updateExactAgentSession(session.agentSessionId, session.run, value => {
      const operation = value.continuityOperations?.[operationId]
      if (!operation?.launchInput || ['terminal-confirmed', 'native-admitted', 'not-applied'].includes(operation.launchInput.state)) return value
      const next = { ...operation, launchInput: { ...operation.launchInput, state } }
      return { ...value, ...(value.continuity?.operationId === operationId ? { continuity: next } : {}),
        continuityOperations: { ...value.continuityOperations, [operationId]: next }, updatedAt: Math.max(value.updatedAt, Date.now()) }
    })
    this.ports.events.publishSession(settled)
    if (['terminal-confirmed', 'native-admitted'].includes(state)) await this.ports.input.recordPromptMessageAfterSideEffect(settled, input.input.submissionId, 'Resume prompt', input.message)
    return settled
  }
  restore(sessions: readonly AgentMuxStoredAgentSession[]): void {
    this.continuityInputs.restore(sessions); this.continuitySupervisor.restore(sessions)
    for (const session of sessions) this.observeInitialInput(session)
  }
  observe(session: AgentMuxStoredAgentSession, retry = false): void { this.continuitySupervisor.observe(session, retry); this.observeInitialInput(session) }
  wake(id: string): void { this.continuitySupervisor.wake(id) }
  userInput(id: string, runId: string): Promise<void> { return this.continuityInputs.userInput(id, runId) }
  protocolAccepted(id: string, runId: string, operationId: string, range: {startByte: number; endByte: number}): Promise<void> { return this.continuityInputs.protocolAccepted(id, runId, operationId, range) }
  async dispose(): Promise<void> {
    this.reopensDisposed = true
    for (const controller of this.providerReads) controller.abort()
    this.initialInputContinuations.clear()
    await this.continuityInputs.dispose()
    this.continuityInputsUnsubscribe()
    await this.continuitySupervisor.dispose()
    await Promise.allSettled([...this.resumedInterruptionReads.values(), ...this.reopenSettlements.values(), ...this.restartSettlements.values()])
  }
}
