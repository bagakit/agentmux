import type { AgentSessionRunLifecycle } from './lifecycle.js'
import type { AgentSessionRecoveryReconciler } from './reconciliation.js'
import { parseTerminalFrontendObservation } from '../agent-terminal-frontend.js'
import type { AgentSessionContinuitySupervisor } from './supervisor.js'
import { inspectAgentSessionInterruption } from './interruption.js'
import { prepareContinuityLaunchInput } from './input.js'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { matchesProviderNativeSessionTarget } from '../agent-native-locator.js'
import { continuityExecutorEntries, readContinuityExecutor, unconfirmedContinuityExecutor, type AgentContinuityExecutor } from './executor.js'
import { composeAgentPrompt } from '../agent-outbound-message.js'
import { type ResolvedAgentInputContextCapture } from '../agent-input-context-capture-resolve.js'
import { AGENT_TERMINAL_HANDSHAKE_FAILED } from '../agent-terminal-handshake-outcome.js'
import { agentPromptNotApplied } from '../agent-prompt-condition.js'
import { sameRun } from '../agent-session-identity.js'
import { AgentMuxError } from '../errors.js'
import { executorUnavailableError } from '../executable-probe.js'
import { agentLifecycleOperationIdentity } from '../agent-session-store.js'
import { normalizeAgentContinuityPolicy, DEFAULT_AGENT_CONTINUITY_CONTINUATION, type AgentMuxContinuityOperation, type AgentMuxAgentContinuityInput, type AgentMuxAgentContinuityResult } from './continuity-contract.js'
import { decideAgentSessionContinuity, agentContinuityAdmission } from './continuity-policy.js'
import type { AgentCapabilitySnapshot, AgentMuxRun, AgentMuxStoredAgentSession } from '../types.js'
import { safeId, terminalEnvironment } from '../agent-runtime-helpers.js'
import type { AgentSessionRecoveryPorts } from './ports.js'

type AgentContinuityAttemptContext = {
  ports: AgentSessionRecoveryPorts
  supervisor: Pick<AgentSessionContinuitySupervisor, 'retainedAutomaticIntent' | 'observe' | 'schedule'>
  lifecycle: Pick<AgentSessionRunLifecycle, 'buildResumePlan' | 'resumeAgentRun' | 'completePreparedResume'>
  reconciler: AgentSessionRecoveryReconciler
  signal: AbortSignal
}

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

/** Performs one original continuity transaction; durable facts remain in the original Store. */
export async function performAgentContinuity(
  context: AgentContinuityAttemptContext, input: AgentMuxAgentContinuityInput, intentOperationId?: string,
  inputContextSource?: import('../browser-input-context.js').BrowserInputContextSource, captured?: ResolvedAgentInputContextCapture
): Promise<AgentMuxAgentContinuityResult> {
  const { ports, supervisor, lifecycle, reconciler, signal } = context
  // A different public Core owner may already have frozen or completed this
  // same operation. Admit only this exact current binding, never a registry catalog.
  const epoch = ports.connection.connectionEpoch
  let current = await ports.sessions.store.readMetadata(input.agentSessionId)
  const retirement = await ports.sessions.store.readRetiredAgentSession(input.agentSessionId)
  ports.connection.assertConnectionEpoch(epoch)
  ports.connection.requireConnected()
  if (current && retirement) throw new AgentMuxError('Session is both active and retired.', 'INVALID_AGENT_SESSION_STORE')
  if (current) {
    await ports.sessions.resolveRawAgentSession(input.agentSessionId)
    current = await ports.sessions.registry.refresh(input.agentSessionId, current.run)
    ports.connection.assertConnectionEpoch(epoch)
  }
  // An admitted explicit restart owns its frozen Stop/Start transaction. A
  // generic observer may report it, but must never reconstruct its executor,
  // schedule it as automatic recovery or replace its original receipt.
  const requested = current?.continuityOperations?.[input.operationId]
  if (requested?.action === 'restart') {
    if (input.input) throw new AgentMuxError('An explicit restart has no authored input. Keep its original operation and submit new input separately.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    if (!sameRun(requested.previousRun, input.expectedRun)) throw new AgentMuxError('A restart observation must retain its original Run.', 'CONTINUITY_OPERATION_MISMATCH')
    if (requested.kind === 'unavailable' && requested.errorCode === AGENT_TERMINAL_HANDSHAKE_FAILED && requested.newRun) {
      throw new AgentMuxError(requested.error ?? 'The original restart replacement exited during startup.', requested.errorCode)
    }
  }
  let reservation: Awaited<ReturnType<typeof ports.sessions.store.readLifecycleReservation>> = null
  let reservationObservationUnknown = false
  if (current && sameRun(current.run, input.expectedRun)) {
    try { reservation = await ports.sessions.store.readLifecycleReservation(input.agentSessionId) }
    catch (error) {
      reservationObservationUnknown = true
      ports.events.publisher.publish({ type: 'agent-error', agentSessionId: input.agentSessionId, code: 'AGENT_LIFECYCLE_OBSERVATION_UNCONFIRMED',
        message: `The original lifecycle could not be observed: ${error instanceof Error ? error.message : String(error)}. The original Session and existing capabilities are retained; check this exact Run and retry the original lifecycle observation.`,
        evidence: { source: 'agentmux', run: input.expectedRun, observedAt: Date.now() } })
    }
  }
  if (reservation?.kind === 'resume' && reservation.restart?.request.operationId === input.operationId && requested?.action !== 'restart') {
    throw new AgentMuxError('This operation belongs to the original restart. Inspect that operation; its Session and all original receipts are retained.',
      'AGENT_CONTINUITY_SUPERSEDED')
  }
  const restart = requested?.action === 'restart' ? requested : !input.input && reservation?.kind === 'resume' && reservation.restart &&
    sameRun(reservation.expectedRun, input.expectedRun)
    ? current?.continuityOperations?.[reservation.restart.request.operationId] : undefined
  let runningObserver = false
  if (current && restart?.action === 'restart' && requested?.action !== 'restart' && sameRun(current.run, input.expectedRun)) {
    try {
      const observed = await ports.runtime.kernel.status(current.run.runId)
      ports.runtime.assertAgentRun(current, observed)
      runningObserver = observed.state.type === 'running'
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'AGENT_SESSION_RUN_MISMATCH') throw error
      // An observation failure is not proof of a running or ended Run.
    }
  }
  if (current && restart?.action === 'restart' && sameRun(restart.previousRun, input.expectedRun) && !runningObserver) {
    const continuity = structuredClone(restart)
    const evidence = { kind: 'run-unknown' as const, observedAt: Date.now(),
      message: 'The original explicit restart is retained. Inspect or explicitly continue that restart operation.' }
    if (restart.kind === 'resumed' && restart.newRun && sameRun(restart.newRun, current.run) &&
      restart.nativeTarget?.kind === 'provider' && matchesProviderNativeSessionTarget(restart.nativeTarget, current.nativeHandle)) {
      return { kind: 'resumed', session: ports.events.projectSession(current), previousRun: { ...input.expectedRun }, run: { ...restart.newRun },
        evidence: { kind: 'provider-native', providerId: restart.nativeTarget.providerId, nativeSessionId: restart.nativeTarget.sessionId,
          previousRun: evidence }, continuity }
    }
    if (!sameRun(current.run, input.expectedRun)) return { kind: 'conflict', agentSessionId: input.agentSessionId,
      previousRun: { ...input.expectedRun }, currentRun: { ...current.run }, reason: 'session-run-changed',
      evidence: { kind: 'agent-session-store' }, continuity }
    return { kind: 'pending', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun },
      reason: 'operation-unconfirmed', evidence, continuity }
  }
  const retained = current && supervisor.retainedAutomaticIntent(current, input)
  if (current && retained) {
    if (retained.initializationRecovery || current.nativeActor?.initializationControl) return await performAgentContinuity(context, { agentSessionId: input.agentSessionId,
      expectedRun: { ...input.expectedRun }, operationId: retained.operationId, trigger: retained.trigger, policy: retained.policy,
      ...(retained.timingOverride ? { timingOverride: retained.timingOverride } : {}) }, retained.intentOperationId)
    supervisor.observe(current)
    let run: AgentMuxRun | null = null
    let evidence: import('./continuity-contract.js').AgentMuxAgentContinuityRunEvidence = { kind: 'run-unknown', observedAt: Date.now(), message: 'Original recovery observation is pending.' }
    try {
      const observed = await ports.runtime.kernel.status(current.run.runId); ports.runtime.assertAgentRun(current, observed); run = ports.events.projectRun(observed, current)
      evidence = run.state === 'running' ? { kind: 'run-running', observedAt: run.observedAt }
        : { kind: 'run-ended', state: run.state as 'exited' | 'interrupted', observedAt: run.observedAt }
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'AGENT_SESSION_RUN_MISMATCH') throw error
      evidence = { kind: 'run-unknown', observedAt: Date.now(), message: error instanceof Error ? error.message : String(error) }
    }
    if (run?.state === 'running') return { kind: 'reattachable', session: ports.events.projectSession(current), previousRun: { ...input.expectedRun }, run,
      evidence: { kind: 'run-running', observedAt: run.observedAt }, continuity: structuredClone(retained) }
    const root = current.continuityOperations?.[retained.intentOperationId ?? retained.operationId]
    return { kind: 'pending', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun },
      reason: root?.supervision?.phase === 'cancelled' ? 'intent-cancelled' : 'recovery-supervised', evidence,
      continuity: structuredClone(retained) }
  }
  // A restarted observer rejoins the admitted automatic intent rather than recomposing its policy or delay.
  if (current?.continuity && !current.continuity.action && !current.continuityOperations?.[input.operationId] &&
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
    if (prior && (!prior.launchInput || !isDeepStrictEqual(prior.launchInput.input, input.input))) throw new AgentMuxError(
      'This original recovery operation has another frozen input. Its original body and Run are kept.', 'AGENT_PROMPT_OPERATION_CONFLICT')
  }
  if (prior && !sameRun(prior.previousRun, input.expectedRun)) {
    throw new AgentMuxError('A continuity operation must retain its original Run.', 'CONTINUITY_OPERATION_MISMATCH')
  }
  const priorFailure = rolledBackResumeFailure(current ?? undefined, input.operationId)
  if (priorFailure) throw priorFailure
  const now = Date.now(), policy = prior?.policy ?? normalizeAgentContinuityPolicy(input.policy)
  let receipt: AgentMuxContinuityOperation = prior ? structuredClone(prior) : {
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
      : { ...common, source: current.creation?.executorRevision || ports.executors.hostExecutorOwner || ports.executors.sessionExecutorConfiguration ? 'host' : 'provider' }
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
    ports.providers.providers.get(current.providerId).catalog, agentLifecycleOperationIdentity('resume', input.agentSessionId, input.operationId), input.input, inputContextSource, captured)!
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
    if (result.kind === 'resumed') {
      if (!sameRun(receipt.newRun ?? receipt.previousRun, result.run)) {
        delete receipt.initializationRecovery
        delete receipt.frontendReconnect
      }
      receipt.newRun = { ...result.run }
    }
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
        current = await ports.sessions.updateExactAgentSession(current.agentSessionId, current.run, value => {
          const latest = value.continuityOperations?.[receipt.operationId]
          if (latest?.action === 'restart' && receipt.action !== 'restart') throw new AgentMuxError(
            'The original operation is an explicit restart. Its receipt and original request are kept.', 'AGENT_CONTINUITY_SUPERSEDED')
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
        ports.events.publishSession(current)
      } catch (error) {
        if (error instanceof AgentMuxError && ['AGENT_PROMPT_OPERATION_CONFLICT', 'AGENT_CONTINUITY_EXECUTOR_CONFLICT', 'AGENT_CONTINUITY_SUPERSEDED'].includes(error.code)) throw error
        receipt.error = `Continuity receipt persistence is unconfirmed. ${error instanceof Error ? error.message : String(error)}`
        ports.events.publisher.publish({ type: 'agent-error', agentSessionId: input.agentSessionId, code: 'AGENT_CONTINUITY_RECEIPT_UNCONFIRMED',
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
    supervisor.schedule(input, receipt)
    return { ...result, ...((result.kind === 'resumed' || result.kind === 'reattachable') && current ? { session: ports.events.projectSession(current) } : {}), continuity: structuredClone(receipt) }
  }
  const recordKnownSupervisedStart = async (error: unknown): Promise<AgentMuxAgentContinuityResult | null> => {
    if (!receipt.supervision && !receipt.intentOperationId) return null
    const canonical = await ports.sessions.store.readMetadata(input.agentSessionId), known = canonical?.continuityOperations?.[input.operationId]
    if (!canonical || !known?.newRun || !sameRun(known.newRun, canonical.run)) return null
    current = canonical
    receipt.newRun = { ...known.newRun }
    if (error instanceof AgentMuxError) receipt.errorCode = error.code
    receipt.error = error instanceof Error ? error.message : String(error)
    return await record({ kind: 'resumed', session: ports.events.projectSession(canonical), previousRun: receipt.previousRun, run: known.newRun,
      evidence: { kind: 'provider-native', providerId: canonical.providerId, nativeSessionId: canonical.nativeHandle!.sessionId,
        previousRun: receipt.evidence as import('./continuity-contract.js').AgentMuxAgentContinuityRunEvidence } }, receipt.reason)
  }
  const pending = (reason: import('./continuity-contract.js').AgentMuxContinuityPendingReason,
    evidence: import('./continuity-contract.js').AgentMuxAgentContinuityRunEvidence, nextActionAt?: number) => record({
      kind: 'pending', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun }, reason, evidence,
      ...(nextActionAt === undefined ? {} : { nextActionAt }) })
  if (current && !sameRun(current.run, input.expectedRun)) {
    if (prior?.newRun && sameRun(prior.newRun, current.run) && prior.kind === 'resumed') {
      if (prior.launchInput?.delivery === 'post-launch' && !['terminal-confirmed', 'native-admitted'].includes(prior.launchInput.state)) {
        current = await reconciler.settleContinuityPostLaunchInput(current, input.operationId)
      }
      return record({ kind: 'resumed', session: ports.events.projectSession(current), previousRun: { ...input.expectedRun }, run: { ...current.run },
        evidence: { kind: 'provider-native', providerId: current.providerId,
          nativeSessionId: current.nativeHandle?.sessionId ?? '', previousRun: prior.evidence as import('./continuity-contract.js').AgentMuxAgentContinuityRunEvidence } }, prior.reason)
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
    try { const observed = await ports.runtime.kernel.status(current.run.runId); ports.runtime.assertAgentRun(current, observed); run = ports.events.projectRun(observed, current) }
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
  const catalog = current ? ports.providers.providers.get(current.providerId).catalog : null
  let admission: ReturnType<typeof agentContinuityAdmission> | undefined
  if (current && run?.state !== 'running') {
    if (prior?.kind === 'reattachable' && prior.frontendReconnect?.frontendId) throw new AgentMuxError(
      'The original frontend reconnection completed. This ended Run needs a new explicit recovery operation.', 'AGENT_CONTINUITY_SUPERSEDED', undefined,
      { disposition: 'not_applied', confirmedInputBytes: null })
    // A prior start with no receipt is observation-only. Never dispatch another start or old input.
    if (prior?.kind === 'starting' || prior?.reason === 'operation-unconfirmed') {
      const lifecycleId = agentLifecycleOperationIdentity('resume', input.agentSessionId, input.operationId)
      let startUnconfirmed = !prior.frontendReconnect && !prior.initializationRecovery
      try {
        const reservation = await ports.sessions.store.loadResumeCorrelation(input.agentSessionId, lifecycleId)
        if (reservation?.preparedSession) {
          // Old-Run frontend/initialization observations cannot hide this operation's
          // durable Start. Reconcile its existing Run before considering another launch.
          startUnconfirmed = true
          const recovered = await lifecycle.completePreparedResume(reservation, await ports.runtime.kernel.inspectCreation(reservation.operationId))
          if (recovered) { current = ports.sessions.registry.get(input.agentSessionId); return record({ kind: 'resumed', session: ports.events.projectSession(current),
            previousRun: { ...input.expectedRun }, run: { ...current.run }, evidence: { kind: 'provider-native', providerId: current.providerId,
              nativeSessionId: current.nativeHandle!.sessionId, previousRun: evidence } }, recovered.continuity?.reason ?? prior.reason) }
        }
      } catch (error) {
        startUnconfirmed = true
        const known = await recordKnownSupervisedStart(error)
        if (known) return known
        receipt.error = error instanceof Error ? error.message : String(error)
      }
      if (startUnconfirmed) {
        receipt.rechecks++
        return pending('operation-unconfirmed', evidence,
          receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined)
      }
    }
    if (receipt.intentOperationId) {
      const root = current.continuityOperations?.[receipt.intentOperationId]
      if (!root?.supervision || root.supervision.activeAttemptOperationId !== receipt.operationId ||
        ['cancelled', 'settled', 'paused'].includes(root.supervision.phase) || !matchesProviderNativeSessionTarget(root.nativeTarget, current.nativeHandle)) {
        throw new AgentMuxError('The original recovery intent no longer authorizes this attempt.', 'AGENT_CONTINUITY_SUPERSEDED')
      }
      admission = { kind: 'resume', reason: 'supervised-retry', interruptedWorking: false }
    } else admission = agentContinuityAdmission({ session: ports.events.projectSession(current), trigger: receipt.trigger, policy,
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
      await ports.runtime.prepareExecutionEnvironment?.()
      receipt.evidence = evidence
      receipt.nativeTarget = structuredClone(handle!)
      // All attempts share only the root's private logical invocation source.
      // Generated Hook credentials and the first input remain attempt-owned.
      // Current target-owned configuration is independently authoritative. A bad
      // private record must not close that original Host owner's recovery path.
      const executor = current.creation?.executorRevision && ports.executors.hostExecutorOwner
        ? { providerId: current.providerId, executorId: current.executorId, source: 'host' as const }
        : readContinuityExecutor(current.continuityExecutors, executorRoot) ?? authoredExecutor
      if (!executor || executor.providerId !== current.providerId || executor.executorId !== current.executorId) throw unconfirmedContinuityExecutor()
      const { commandOverride: _command, args: _args, env: _env, ...rest } = input
      const originalInput: AgentMuxAgentContinuityInput = rest
      if (current.creation?.executorRevision || executor.source === 'host') {
        if (!ports.executors.hostExecutorOwner && (current.creation?.executorRevision || !ports.executors.sessionExecutorConfiguration)) throw unconfirmedContinuityExecutor()
        input = await ports.executors.sessionExecutorOptions(current, originalInput)
      } else input = executor.source === 'sdk' ? { ...originalInput, ...structuredClone(executor.options) } : originalInput
      const oldInput = current?.promptCompletionAdmission
      receipt.previousInput = { scope: 'typed-prompt', outcome: !oldInput ? 'none' : current && agentPromptNotApplied(current) ? 'not-applied'
        : oldInput.acknowledged ? oldInput.transport === 'native' ? oldInput.native.outcome === 'admitted' ? 'native-admitted' : 'unknown' : 'terminal-confirmed' : 'unknown',
        ...(oldInput?.inputKey ? { key: structuredClone(oldInput.inputKey) } : {}) }
      // Restore the original conversation independently of any new automatic input.
      // Freeze old-writer evidence before resume can create an initial-idle predecessor.
      if (!receipt.interruption && !receipt.intentOperationId) receipt.interruption = await inspectAgentSessionInterruption(current,
        ports.providers.providers.get(current.providerId), policy, [])
      receipt.interruptedWorking = !receipt.intentOperationId && receipt.interruption?.state === 'interrupted'
      if (!prior?.recoveryInputs) receipt.recoveryInputs = { reminder: '',
        continuation: receipt.trigger !== 'input' && receipt.interruptedWorking && policy.continuationEnabled ? DEFAULT_AGENT_CONTINUITY_CONTINUATION : '' }
      const launchInput = prior?.launchInput ?? prepareContinuityLaunchInput(receipt, catalog!,
        agentLifecycleOperationIdentity('resume', input.agentSessionId, input.operationId), input.input, inputContextSource, captured)
      if (launchInput) receipt.launchInput = launchInput
      const originalPrompt = receipt.launchInput?.prompt ?? ''
      const { plan } = lifecycle.buildResumePlan(current, input, originalPrompt || undefined)
      launchExecutable = plan.command
      capabilityContext = { workspacePath: current.workspacePath, env: terminalEnvironment(plan.env) }
      capability = await ports.providers.probeAgent(current.providerId, plan.command, capabilityContext)
      // This fresh observation replaces the previous preflight failure for this attempt.
      // Other operation receipts and failures after an admitted Start remain intact.
      delete receipt.error; delete receipt.errorCode
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error)
      delete receipt.errorCode
      if (error instanceof AgentMuxError) receipt.errorCode = error.code
      if (prior) receipt.rechecks++
      return pending('provider-unverified', evidence, receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined)
    }
  }
  const decision = decideAgentSessionContinuity({ agentSessionId: input.agentSessionId,
    hostId: current?.hostId ?? retirement?.hostId ?? 'local', expectedRun: input.expectedRun, observedAt: now,
    session: current ? ports.events.projectSession(current) : null, retirement: retirement ? structuredClone(retirement) : null,
    run, catalog, capability, ...(launchExecutable === undefined ? {} : { launchExecutable }) })
  if (decision.kind === 'reattachable' && current) {
    if (prior && (prior.errorCode === 'AGENT_NOT_FOUND' || ['provider-unavailable', 'provider-unverified'].includes(prior.reason))) {
      delete receipt.error; delete receipt.errorCode
    }
    const provider = ports.providers.providers.get(current.providerId)
    await ports.terminal.ensureTerminalFrontendObservation(current)
    const frontend = ports.terminal.readFrontendObservation(current.agentSessionId)
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
        const exact = await reconciler.exactRecoverySession(current)
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
          const runtime = await ports.runtime.requireCurrentAgentRun(current)
          if (runtime.state.type !== 'running' || !runtime.pid) return pending('runtime-unverified', evidence)
          next = await reconciler.recoverOriginalFrontend(current, runtime, { operationId: receipt.operationId,
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
        const runtime = await ports.runtime.requireCurrentAgentRun(current)
        const exactReady = await reconciler.exactRecoverySession(current, receipt.operationId)
        if (!exactReady) return pending('intent-cancelled', evidence)
        current = await reconciler.bindInitializedNativeSession(exactReady, runtime, next)
        receipt.nativeTarget = structuredClone(current.nativeHandle as NonNullable<AgentMuxContinuityOperation['nativeTarget']>)
        const dispatch = await reconciler.exactRecoverySession(current, receipt.operationId)
        if (!dispatch) return pending('intent-cancelled', evidence)
        current = await ports.input.continueInitialInput(dispatch, runtime, () => reconciler.assertRecoveryInputCurrent(dispatch, receipt.operationId))
        for (const operation of Object.values(current.continuityOperations ?? {})) if (operation.launchInput?.key?.expectedRun.runId === current.run.runId &&
          operation.launchInput.delivery === 'post-launch') current = await reconciler.settleContinuityPostLaunchInput(current, operation.operationId)
        if (next.state === 'attached') {
          current = await reconciler.acceptRecoveredFrontend(current, runtime, next, receipt.initializationRecovery.outputAfterByte)
          delete receipt.error; delete receipt.errorCode
          return record({ ...decision, session: ports.events.projectSession(current) }, 'initialization-ready')
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
        const lifecycle = await ports.sessions.store.readLifecycleReservation(current.agentSessionId)
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
        const observed = await reconciler.recoverOriginalFrontend(current, await ports.runtime.requireCurrentAgentRun(current), {
          operationId: receipt.frontendReconnect.operationId ?? input.operationId,
          expectedFrontendId: receipt.frontendReconnect.previousFrontendId, target: { kind: 'native-session', nativeSessionId: target.sessionId } }, receipt.operationId)
        const next = parseTerminalFrontendObservation(observed)
        receipt.frontendReconnect.frontendId = next.frontendId
        await pending('operation-unconfirmed', evidence)
        current = await reconciler.acceptRecoveredFrontend(current, await ports.runtime.requireCurrentAgentRun(current), next, receipt.frontendReconnect.outputAfterByte)
        return record({ ...decision, session: ports.events.projectSession(current) }, 'frontend-reconnected')
      } catch (error) {
        receipt.error = error instanceof Error ? error.message : String(error)
        receipt.errorCode = error instanceof AgentMuxError ? error.code : 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED'
        if (prior) receipt.rechecks++
        return pending('operation-unconfirmed', evidence, receipt.rechecks < policy.recheckMaxAttempts ? now + policy.recheckIntervalMs : undefined)
      }
    }
  }
  if (decision.kind === 'reattachable' && current && input.env !== undefined) {
    void ports.hooks.ensureManagedHooks(ports.providers.providers.get(current.providerId), current.workspacePath, current.agentSessionId,
      input.env, ports.hooks.activeBinding(current.run.runId)?.endpoint).catch(error => {
      if (epoch !== ports.connection.connectionEpoch || signal.aborted) return
      receipt.error = `Managed Hook restoration is unconfirmed. The original running Agent remains available. ${error instanceof Error ? error.message : String(error)}`
      ports.events.publisher.publish({ type: 'agent-error', agentSessionId: input.agentSessionId, code: 'AGENT_CONTINUITY_HOOK_UNCONFIRMED',
        message: receipt.error, evidence: { source: 'agentmux', run: input.expectedRun, observedAt: now } })
    })
  }
  if (decision.kind === 'unavailable' && decision.reason === 'provider-unavailable' && capability &&
      !capability.installed && capability.executableObservation?.availability === 'missing' &&
      capability.providerId === current?.providerId && capability.executable === launchExecutable &&
      capability.executableObservation.executable === launchExecutable) {
    const failure = executorUnavailableError(catalog!.label, capability)
    receipt.error = failure.message
    receipt.errorCode = failure.code
  }
  if (decision.kind !== 'resume') return record(decision)
  if (reservationObservationUnknown) return pending('operation-unconfirmed', evidence)
  if (receipt.supervision?.phase === 'settled' && receipt.supervision.attemptCount === 0) throw new AgentMuxError(
    'The original attachment intent is complete. A new recovery needs its own explicit operation.', 'AGENT_CONTINUITY_SUPERSEDED', undefined,
    { disposition: 'not_applied', confirmedInputBytes: null })
  try { await ports.hooks.requireHookIngressOwner() }
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
  current = await ports.sessions.updateExactAgentSession(input.agentSessionId, input.expectedRun, value => {
    if (value.continuityOperations?.[receipt.operationId]?.action === 'restart' && receipt.action !== 'restart') throw new AgentMuxError(
      'The original operation is an explicit restart. Its receipt and original request are kept.', 'AGENT_CONTINUITY_SUPERSEDED')
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
    const session = await lifecycle.resumeAgentRun({ agentSessionId: input.agentSessionId, operationId: input.operationId,
      ...(input.args === undefined ? {} : { args: input.args }), ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride }),
      ...(input.cols === undefined ? {} : { cols: input.cols }), ...(input.rows === undefined ? {} : { rows: input.rows }),
      ...(receipt.launchInput ? { prompt: receipt.launchInput.input.prompt,
        ...(receipt.launchInput.input.agentMuxNote === undefined ? {} : { agentMuxNote: receipt.launchInput.input.agentMuxNote }) } : {})
    }, input.expectedRun, capability && capabilityContext ? { snapshot: capability, context: capabilityContext } : undefined)
    current = await reconciler.observeResumedInterruption(ports.sessions.registry.get(input.agentSessionId))
    // Re-read the accepted attempt so record cannot overwrite its separately observed evidence.
    const completed = current.continuityOperations?.[receipt.operationId]
    if (completed) receipt = structuredClone(completed)
    return record({ kind: 'resumed', session: ports.events.projectSession(current), previousRun: { ...input.expectedRun }, run: { ...session.run },
      evidence: { kind: 'provider-native', providerId: decision.nativeHandle.providerId,
        nativeSessionId: decision.nativeHandle.sessionId, previousRun: decision.evidence } }, receipt.reason)
  } catch (error) {
    const known = await recordKnownSupervisedStart(error)
    if (known) return known
    try { current = ports.sessions.registry.get(input.agentSessionId) } catch {}
    const failure = rolledBackResumeFailure(current ?? undefined, input.operationId)
    if (failure) {
      failure.cause = error
      throw failure
    }
    if (error instanceof AgentMuxError && ['AGENT_SESSION_BUSY', 'STALE_AGENT_SESSION', 'UNKNOWN_AGENT_SESSION'].includes(error.code)) {
      const retired = await ports.sessions.store.readRetiredAgentSession(input.agentSessionId)
      ports.connection.assertConnectionEpoch(epoch)
      if (retired?.hostId === 'local' && sameRun(retired.run, input.expectedRun)) return record({ kind: 'retired', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun },
        evidence: { kind: 'user-retired', observedAt: retired.observedAt } })
      return record({ kind: 'conflict', agentSessionId: input.agentSessionId, previousRun: { ...input.expectedRun },
        reason: 'lifecycle-busy', evidence: { kind: 'agent-session-store' } })
    }
    receipt.error = error instanceof Error ? error.message : String(error)
    if (receipt.launchInput?.state === 'prepared') receipt.launchInput.state = error instanceof AgentMuxError &&
      error.creationFailure?.operationId === agentLifecycleOperationIdentity('resume', input.agentSessionId, input.operationId) &&
      error.creationFailure.disposition === 'not_applied' ? 'not-applied' : 'unknown'
    return pending('operation-unconfirmed', evidence, policy.recheckMaxAttempts > 0 ? now + policy.recheckIntervalMs : undefined)
  }
}
