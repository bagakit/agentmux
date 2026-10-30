import type { AgentMuxCreationRuntime } from '../terminal-creation-retirement.js'
import { assertPreparedResumeBinding, resumeResolutionRequest, resumeResolutionDigest } from '../agent-prepared-resume.js'
import { decodePreparedRun } from '../prepared-run.js'
import { hasSelectedNativeTarget } from '../agent-native-source.js'
import { lifecycleObserved } from '../lifecycle-diagnostic.js'
import type { AgentSessionRecoveryReconciler } from './reconciliation.js'
import { parseAgentRestartInput, type AgentMuxAgentRestartIdentity, type AgentMuxAgentRestartInput, type AgentMuxAgentRestartInspection } from './restart-contract.js'
import type { AgentSessionContinuitySupervisor } from './supervisor.js'
import { createContinuityInputDelivery, prepareContinuityLaunchInput, bindContinuityLaunchInput } from './input.js'
import { executorUnavailableError } from '../executable-probe.js'
import { unconfirmedExecutableObservation } from '../executable-observation.js'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { matchesProviderNativeSessionTarget } from '../agent-native-locator.js'
import { splitLaunchPromptByDelivery } from '../agent-provider.js'
import { composeAgentResumePrompt } from '../agent-outbound-message.js'
import { hookBindingIdentity, hashAgentCapability, issueAgentCapability } from '../agent-capability.js'
import { AGENT_TERMINAL_HANDSHAKE_FAILED } from '../agent-terminal-handshake-outcome.js'
import { sameRun } from '../agent-session-identity.js'
import { type CtxmuxAdapterRun } from '../ctxmux-run-adapter.js'
import { AgentMuxError } from '../errors.js'
import { agentLifecycleOperationIdentity, type AgentMuxLifecycleReservation, type AgentMuxPreparedResumeDispatch } from '../agent-session-store.js'
import { normalizeAgentContinuityPolicy, type AgentMuxContinuityOperation, type AgentMuxAgentContinuityRunEvidence, type AgentMuxAgentContinuityInput, type AgentMuxAgentContinuityResult } from './continuity-contract.js'
import { type AgentHookBinding } from '../hook-server.js'
import type { AgentCapabilitySnapshot, AgentLaunchPromptInputPlan, AgentMuxAgentSession, AgentPromptMessageContent, AgentMuxRunRef, AgentMuxStoredAgentSession } from '../types.js'
import { agentCreationIntentDigest } from '../agent-creation-authority.js'
import type { AgentMuxAgentResumeInput, AgentMuxAgentReopenInput, AgentMuxAgentResumeOperationInput } from './resume-contract.js'
import { runRef, safeId, terminalHandshakeOperationIdentity, terminalInitialPromptReadinessIdentity, terminalEnvironment } from '../agent-runtime-helpers.js'
import type { AgentSessionRecoveryPorts } from './ports.js'

/** A saved terminal observation names this exact old Run and native target, never a missing mapping. */
function retainedRunEnd(session: AgentMuxStoredAgentSession | undefined): Extract<AgentMuxAgentContinuityRunEvidence, { kind: 'run-ended' }> | undefined {
  if (!session) return
  for (const operation of [session.continuity, ...Object.values(session.continuityOperations ?? {})]) {
    if (operation && sameRun(operation.previousRun, session.run) &&
        matchesProviderNativeSessionTarget(operation.nativeTarget, session.nativeHandle) && operation.evidence.kind === 'run-ended') {
      return structuredClone(operation.evidence)
    }
  }
}

/** Executes original lifecycle reservations; shares the supervisor's single Session serializer. */
export class AgentSessionRunLifecycle {
  private readonly executingRestarts = new Set<string>()
  private readonly restartSettlements = new Map<string, Promise<void>>()
  private readonly executingReopens = new Set<string>()
  private readonly reopenSettlements = new Map<string, Promise<void>>()
  constructor(
    private readonly ports: AgentSessionRecoveryPorts,
    private readonly continuitySupervisor: Pick<AgentSessionContinuitySupervisor, 'serialize'>,
    private readonly reconciler: AgentSessionRecoveryReconciler,
    private readonly signal: AbortSignal
  ) {}

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
    if (this.signal.aborted) throw new AgentMuxError('This restart owner has been disposed. Use the current Core owner and the original operation.', 'AGENT_RESTART_OWNER_DISPOSED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
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
      // Only this invocation's preflight proves preparation; a durable reservation does not.
      let preparedCapability: Parameters<AgentSessionRunLifecycle['resumeAgentRun']>[2]
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
          const restored = await this.completePreparedResume(reservation)
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
        await this.ports.runtime.prepareExecutionEnvironment?.()
        // Resolve the real replacement before interrupting useful work. Freeze these exact options in the original durable operation.
        const frozen = parseAgentRestartInput({ ...input, ...await this.ports.executors.sessionExecutorOptions(canonical, input) })
        const { plan } = this.buildResumePlan(canonical, frozen)
        const context = { workspacePath: canonical.workspacePath, env: terminalEnvironment(plan.env) }
        const capability = await this.ports.providers.probeAgent(canonical.providerId, plan.command, context)
        preparedCapability = { snapshot: capability, context }
        if (!capability.installed && !(capability.providerId === provider.id && unconfirmedExecutableObservation(capability, plan.command))) throw executorUnavailableError(provider.label, capability)
        await this.ports.hooks.requireHookIngressOwner()
        const stopOperation = await this.ports.runtime.kernel.prepareStop(input.expectedRun.runId, operation + '-stop')
        reservation = await this.ports.sessions.registry.reserveRestart(input.agentSessionId, input.expectedRun, operation,
          { requestDigest: digest, request: frozen, nativeTarget: structuredClone(canonical.nativeHandle), stopOperation })
      }
      // The Store fences both the original reservation and its receipt in one transaction.
      const recorded = await this.ports.sessions.store.recordRestartAdmission(reservation)
      await this.ports.sessions.registry.refresh(input.agentSessionId, input.expectedRun)
      this.ports.events.publishSession(recorded)
      return await this.resumeAgentRun(reservation.restart!.request, input.expectedRun, preparedCapability, undefined, digest, reservation)
    } finally { this.executingRestarts.delete(operation); this.restartSettlements.delete(operation); settle() }
  }

  async inspectAgentRestart(value: AgentMuxAgentRestartIdentity): Promise<AgentMuxAgentRestartInspection> {
    const input = parseAgentRestartInput(value, true)
    const result: AgentMuxAgentRestartInspection = { ...input, previousRun: { ...input.expectedRun }, phase: 'not-found', canRetry: true, observedAt: Date.now() }
    const canonical = await this.ports.sessions.store.readMetadata(input.agentSessionId)
    const prior = canonical?.continuityOperations?.[input.operationId]
    if (prior) {
      const operation = agentLifecycleOperationIdentity('restart', input.agentSessionId, input.operationId)
      const reservation = await this.ports.sessions.store.loadResumeCorrelation(input.agentSessionId, operation)
      if (reservation?.restart && sameRun(reservation.expectedRun, input.expectedRun) &&
          (prior.action !== 'restart' || prior.requestDigest !== reservation.restart.requestDigest ||
           !sameRun(prior.previousRun, reservation.expectedRun) || !matchesProviderNativeSessionTarget(reservation.restart.nativeTarget, prior.nativeTarget))) {
        const conflict = { ...result, session: this.ports.events.projectSession(canonical!), phase: 'unconfirmed' as const, canRetry: false }
        if (reservation.preparedSession) {
          try {
            const run = await this.inspectPreparedResume(reservation), frozen = reservation.preparedSession.continuity?.restartLaunch
            const exact = run?.lifecycleOperationId === operation && run.workspacePath === reservation.preparedSession.workspacePath && frozen &&
              frozen.program === run.program && frozen.argsDigest === createHash('sha256').update(JSON.stringify(run.args)).digest('base64url')
            return { ...conflict, ...(exact && run ? { newRun: runRef(run.runId) } : {}), detail: exact
              ? 'The original Start was found, but its retained receipt conflicts. Inspect this same operation again; the conflicting receipt remains unresolved, and no Start or input was repeated.'
              : 'The original Start is unconfirmed and its retained receipt conflicts. Inspect this same operation again; no Start or input was repeated.' }
          } catch (error) {
            return { ...conflict, detail: `The original Start inspection is unconfirmed: ${error instanceof Error ? error.message : String(error)}. Inspect this same operation again; no Start or input was repeated.` }
          }
        }
        return { ...conflict, detail: 'The original restart reservation and another retained receipt disagree. Both requests are kept; after the original owner releases or exits, explicitly close the exact Session to retain its history, or inspect the conflicting receipt.' }
      }
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
      const run = await this.inspectPreparedResume(reservation)
      const frozen = reservation.preparedSession.continuity?.restartLaunch
      if (run?.lifecycleOperationId === operation && run.workspacePath === reservation.preparedSession.workspacePath && frozen &&
        frozen.program === run.program && frozen.argsDigest === createHash('sha256').update(JSON.stringify(run.args)).digest('base64url')) {
        return { ...result, phase: 'starting', canRetry: true, newRun: runRef(run.runId), detail: 'Original Start found; repeat the same restart request to confirm its Session commit.' }
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
            ? await this.reconciler.settleContinuityPostLaunchInput(this.ports.sessions.registry.get(input.agentSessionId), input.operationId) : this.ports.sessions.registry.get(input.agentSessionId)
          return this.ports.events.projectSession(restored)
        }
        if (reservation?.preparedSession && sameRun(reservation.expectedRun, canonical.run)) {
          const restored = await this.completePreparedResume(reservation)
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
    if (this.signal.aborted) throw new AgentMuxError('This continue owner has been disposed. Use the current Core client.', 'AGENT_REOPEN_OWNER_DISPOSED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
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
    if (this.signal.aborted) throw this.reopenUnconfirmed('This continue owner has been disposed. Confirm the original operation through the current Core client.')
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
      return this.ports.events.projectSession(await this.completePreparedReopen(reservation, await this.ports.runtime.kernel.inspectCreation(reservation.operationId)))
    } catch (error) {
      if (error instanceof AgentMuxError && error.controlFailure) throw error
      throw this.reopenUnconfirmed(error instanceof Error ? error.message : String(error))
    } finally { this.executingReopens.delete(operationId); this.reopenSettlements.delete(operationId); settle() }
  }

  private reopenUnconfirmed(message: string): AgentMuxError {
    return new AgentMuxError(message, 'AGENT_REOPEN_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
  }

  async completePreparedReopen(
    reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, run: CtxmuxAdapterRun | null
  ): Promise<AgentMuxStoredAgentSession> {
    const prepared = reservation.preparedSession
    if (!prepared || !run || run.lifecycleOperationId !== reservation.operationId || run.workspacePath !== prepared.workspacePath ||
      run.runId === reservation.expectedRetirement.run.runId) {
      throw this.reopenUnconfirmed('The original continue has no single confirmed matching Run. Keep its history and check again.')
    }
    const retirement = reservation.expectedRetirement
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
    this.ports.events.publisher.publish(lifecycleObserved(reservation, runRef(run.runId)))
    return this.ports.sessions.registry.get(next.agentSessionId)
  }

  private async restoreReopenObservation(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun, operationId: string): Promise<void> {
    try {
      if (!this.ports.hooks.hasActiveBinding(run.runId)) {
        await this.ports.hooks.requireHookIngressOwner()
        const binding = this.ports.hooks.pendingBinding(operationId) ?? this.ports.hooks.hookServer.createBinding(
          session.agentSessionId, session.providerId, session.hookBindingId, session.hookToken)
        this.ports.hooks.retainBinding(operationId, binding)
        await binding.bindRun(run.runId)
        this.ports.hooks.activateBinding(run.runId, binding, operationId)
      }
    } catch (error) {
      this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: 'AGENT_REOPEN_OBSERVATION_UNCONFIRMED',
        message: `The original conversation has Run ${run.runId}; its Hook observation is unconfirmed. Keep this Run and check again. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now() } })
    }
    this.ports.runtime.recordRunTransition(null, run)
    this.ports.events.publishSession(session)
    this.ports.events.publisher.publishRunState(this.ports.events.projectRun(run, this.ports.sessions.registry.get(session.agentSessionId)), session.agentSessionId)
  }

  buildResumePlan(session: Pick<AgentMuxAgentSession, 'workspacePath' | 'providerId' | 'nativeHandle' | 'launchOptions'>,
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

  /** Only the original input owner stores the launch outcome; observation failure keeps the Run usable. */
  async settleContinuityMessageInput(operation: AgentMuxContinuityOperation,
    result: { outcome: 'launch-carried'; run: AgentMuxRunRef } | { outcome: 'not-applied' | 'unknown' }): Promise<void> {
    if (!operation.messageInput?.plan) return
    try {
      await this.ports.input.settleContinuityMessage(operation.messageInput, result)
      if (operation.errorCode === 'AGENT_CONTINUITY_MESSAGE_RECEIPT_UNCONFIRMED') { delete operation.errorCode; delete operation.error }
    } catch (error) {
      operation.errorCode = 'AGENT_CONTINUITY_MESSAGE_RECEIPT_UNCONFIRMED'
      operation.error = `The original message launch receipt is unconfirmed. Its input key and recovery operation are retained; inspect this same operation. ${error instanceof Error ? error.message : String(error)}`
      this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: operation.agentSessionId,
        code: operation.errorCode, message: operation.error,
        evidence: { source: 'agentmux', observedAt: Date.now(), run: result.outcome === 'launch-carried' ? result.run : operation.previousRun } })
    }
  }

  async resumeAgentRun(
    input: AgentMuxAgentResumeOperationInput,
    expectedRun?: AgentMuxRunRef,
    knownCapability?: { snapshot: AgentCapabilitySnapshot; context: { workspacePath: string; env: Record<string, string> } },
    reopening?: AgentMuxAgentReopenInput,
    directRequestDigest?: string,
    restartReservation?: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>,
    resolutionHandoff?: { reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>; runtime: AgentMuxCreationRuntime }
  ): Promise<AgentMuxAgentSession> {
    this.ports.connection.requireConnected()
    const previous = reopening ? undefined : this.ports.sessions.requireAgentSession(input.agentSessionId)
    let continuity = previous?.continuityOperations?.[input.operationId] ? structuredClone(previous.continuityOperations[input.operationId])
      : previous?.continuity?.operationId === input.operationId ? structuredClone(previous.continuity) : undefined
    if (expectedRun && previous && !sameRun(previous.run, expectedRun)) {
      throw new AgentMuxError('Agent Session changed before native resume.', 'STALE_AGENT_SESSION')
    }
    if (resolutionHandoff && continuity) continuity = { ...continuity, kind: 'starting', reason: 'explicit-request' }
    const frozenInput = continuity?.launchInput
    const frozenMessage = continuity?.messageInput
    let messageInLaunch = Boolean(frozenMessage && frozenMessage.admissionIntent.kind !== 'native-conversation' && previous &&
      this.ports.providers.providers.get(previous.providerId).catalog.promptDelivery !== 'post-launch-only')
    const composed = frozenInput ? { text: frozenInput.prompt, systemContext: frozenInput.message.systemContext }
      : messageInLaunch ? { text: frozenMessage!.prompt, systemContext: frozenMessage!.message.systemContext }
      : composeAgentResumePrompt(input.prompt, input.agentMuxNote)
    let prompt = composed.text || undefined
    const message: AgentPromptMessageContent = frozenInput?.message ?? frozenMessage?.message ?? {
      ...(composed.systemContext ? { systemContext: composed.systemContext } : {}),
      ...(input.prompt?.trim() ? { userContent: input.prompt } : {})
    }
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      restartReservation ? 'restart' : reopening ? 'reopen' : 'resume', input.agentSessionId,
      safeId(input.operationId, 'Agent resume operation id')
    )
    if (frozenMessage && frozenMessage.lifecycleOperationId !== lifecycleOperationId) throw new AgentMuxError(
      'The recovery message belongs to another original lifecycle operation.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    if (!knownCapability) await this.ports.runtime.prepareExecutionEnvironment?.()
    let reservation = resolutionHandoff?.reservation ?? restartReservation ?? (reopening
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
      let ended: Extract<AgentMuxAgentContinuityRunEvidence, { kind: 'run-ended' }> | undefined = oldRun && oldRun.state.type !== 'running'
        ? { kind: 'run-ended', state: oldRun.state.type, observedAt: Date.now() } : retainedRunEnd(previous)
      if (reservation.kind === 'resume' && !restartReservation && !ended) throw new AgentMuxError(
        'The original Run has no confirmed terminal observation. A missing Run on this Runtime does not authorize replacement; the Session and original operation are retained.',
        'AGENT_RESUME_ORIGINAL_RUN_UNCONFIRMED')
      if (directRequestDigest && (!restartReservation || !continuity)) {
        const now = Date.now()
        continuity = { operationId: input.operationId, agentSessionId: current.agentSessionId, trigger: restartReservation ? 'manual' : 'input',
          ...(restartReservation ? { action: 'restart' as const } : {}),
          policy: normalizeAgentContinuityPolicy(), previousRun: { ...current.run }, nativeTarget: structuredClone(current.nativeHandle),
          admittedAt: now, observedAt: now, rechecks: 0, kind: 'starting', reason: 'explicit-request', requestDigest: directRequestDigest,
          evidence: ended ?? { kind: 'run-missing', observedAt: now },
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
      if (current.toolExecution && !this.ports.executors.prepareToolExecutionLaunch) throw new AgentMuxError('The original tool execution owner is unavailable; no local replacement was started.', 'EXECUTION_HELPER_UNAVAILABLE')
      const managedLaunch = current.toolExecution
        ? { plan: await this.ports.executors.prepareToolExecutionLaunch!(provider, plan, current.toolExecution, current.workspacePath, current.agentSessionId, { lifecycleOperationId, capability: invocationCapability }) }
        : await provider.prepareManagedLaunch?.(plan, lifecycleOperationId, { kind: 'resume', ...(prompt === undefined ? {} : { prompt }) })
      if (managedLaunch) plan = managedLaunch.plan
      if (managedLaunch?.promptDelivery === 'post-launch' && prompt) {
        deferredResumePrompt = frozenMessage ? '' : prompt
        if (frozenMessage) { messageInLaunch = false; prompt = undefined }
        if (continuity?.launchInput) {
          if (continuity.launchInput.state !== 'prepared' || continuity.launchInput.key || continuity.launchInput.launchPlan) throw new AgentMuxError(
            'The original input delivery plan was already dispatched or frozen. Its original receipt is retained.', 'AGENT_PROMPT_OPERATION_CONFLICT')
          // Provider qualification precedes prepareResume's immutable launch plan.
          // Only the carrier converges; original key/body/message remain unchanged.
          continuity.launchInput.delivery = 'post-launch'
        }
      }
      if (frozenMessage?.plan && !messageInLaunch) throw new AgentMuxError(
        'The original message launch cannot change to a different input transport.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      const withoutPreviousNativeActor = { ...current }
      delete (withoutPreviousNativeActor as Partial<AgentMuxStoredAgentSession>).nativeActor
      const nativeSession = { ...withoutPreviousNativeActor, ...(managedLaunch?.nativeActor ? { nativeActor: managedLaunch.nativeActor } : {}) }
      await this.ports.hooks.requireHookIngressOwner()
      if (restartReservation) {
        if (!matchesProviderNativeSessionTarget(restartReservation.restart?.nativeTarget, current.nativeHandle)) throw new AgentMuxError('The original restart native target changed.', 'AGENT_RESTART_CONFLICT')
        if (oldRun?.state.type === 'running') {
          try { await this.ports.runtime.requestStop(restartReservation.restart!.stopOperation) }
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
        ended = oldRun ? { kind: 'run-ended', state: oldRun.state.type as 'exited' | 'interrupted', observedAt: Date.now() } : retainedRunEnd(previous)
        if (!ended) throw new AgentMuxError('The original Run end is unconfirmed on this Runtime. The original restart remains available for exact observation.', 'AGENT_RESTART_UNCONFIRMED')
        if (continuity) continuity.evidence = ended
        if (continuity) {
          continuity.reason = 'restart-starting'
          const pending = structuredClone(continuity)
          this.ports.events.publishSession(await this.ports.sessions.updateExactAgentSession(current.agentSessionId, current.run, session => ({ ...session,
            continuity: pending, continuityOperations: { ...session.continuityOperations, [input.operationId]: pending }, updatedAt: Math.max(session.updatedAt + 1, Date.now()) })))
        }
      }
      await this.ports.hooks.closeRunBinding(current.run.runId)
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
        this.ports.hooks.retainBinding(lifecycleOperationId, hookBinding)
      }
      if (reopening && this.signal.aborted) throw new AgentMuxError('Continue owner was disposed before dispatch.', 'AGENT_REOPEN_OWNER_DISPOSED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
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
      const launch = { program: plan.command, args: plan.args, cwd: current.workspacePath, env: launchEnvironment,
        ...(input.cols === undefined ? {} : { cols: input.cols }), ...(input.rows === undefined ? {} : { rows: input.rows }) }
      let dispatch: AgentMuxPreparedResumeDispatch | undefined
      if (reservation.kind === 'resume') {
        if (continuity?.operationId !== input.operationId || !ended) throw new AgentMuxError(
          'The original resume intent or ended Run is unconfirmed. No Start was dispatched.', 'AGENT_RESUME_UNCONFIRMED')
        const request = this.ports.runtime.kernel.prepareStart(launch)
        const identity = { program: request.program, argsDigest: createHash('sha256').update(JSON.stringify(request.args)).digest('base64url') }
        dispatch = { prepared: { createOperationId: lifecycleOperationId, workspacePath: current.workspacePath,
          launch: JSON.stringify({ createOperationId: lifecycleOperationId, request }) },
          runtime: this.ports.runtime.kernel.creationRuntimeIdentity(), nativeTarget: structuredClone(current.nativeHandle) }
        if (restartReservation) {
          if (restartReservation.restart?.startNotApplied && continuity.restartLaunch && !isDeepStrictEqual(continuity.restartLaunch, identity)) throw new AgentMuxError(
            'The original not-applied restart launch changed. Its original plan and native identity are retained.', 'AGENT_RESTART_CONFLICT')
          continuity.restartLaunch = identity
        }
        if (continuity.launchInput) continuity.launchInput.launchPlan = identity
        if (continuity.messageInput && messageInLaunch) {
          const messagePlan: AgentLaunchPromptInputPlan = { kind: 'runtime-launch', lifecycleOperationId,
            nativeTarget: structuredClone(current.nativeHandle), ...identity }
          if (continuity.messageInput.plan && !isDeepStrictEqual(continuity.messageInput.plan, messagePlan)) throw new AgentMuxError(
            'The original message launch arguments or native target changed.', 'AGENT_PROMPT_OPERATION_CONFLICT')
          continuity.messageInput.plan = messagePlan
        }
        continuity.evidence = ended
        const prepared = { ...nativeSession, continuity,
          continuityOperations: { ...previous?.continuityOperations, [input.operationId]: continuity },
          hookBindingId: hookBinding.bindingId, hookToken: hookBinding.endpoint.token,
          capabilityHash: hashAgentCapability(invocationCapability) }
        reservation = resolutionHandoff
          ? await this.ports.sessions.registry.handoffResumeResolution(resolutionHandoff.reservation, prepared, dispatch, resolutionHandoff.runtime)
          : await this.ports.sessions.registry.prepareResume(reservation, prepared, dispatch)
        if (resolutionHandoff) continuity = structuredClone(reservation.preparedSession!.continuity!)
        if (reservation.kind !== 'resume' || !isDeepStrictEqual(reservation.preparedDispatch, dispatch)) throw new AgentMuxError(
          'The complete original resume dispatch was not durably retained. No Start was dispatched.', 'AGENT_RESUME_UNCONFIRMED')
        this.ports.hooks.retainBinding(lifecycleOperationId, hookBinding)
      }
      if (continuity?.messageInput?.plan) {
        try { await this.ports.input.claimContinuityMessage(continuity.messageInput, continuity.messageInput.plan) }
        catch (error) {
          if (!(error instanceof AgentMuxError && error.controlFailure?.disposition === 'not_applied')) {
            preserveUnconfirmedRun = true
            await this.settleContinuityMessageInput(continuity, { outcome: 'unknown' })
          }
          throw error
        }
      }
      launchAttempted = true
      const run = await (dispatch
        ? this.ports.runtime.kernel.startPrepared(decodePreparedRun(dispatch.prepared).request, lifecycleOperationId, dispatch.runtime)
        : this.ports.runtime.kernel.start({ operationKey: lifecycleOperationId, ...launch })).catch(async error => {
        if (!(error instanceof AgentMuxError && error.creationFailure?.operationId === lifecycleOperationId &&
          error.creationFailure.disposition === 'not_applied')) {
          // A lost start ACK may already own a Run. Keep the one reservation until authoritative reconciliation.
          preserveUnconfirmedRun = true
          if (continuity) await this.settleContinuityMessageInput(continuity, { outcome: 'unknown' })
          const failure = new AgentMuxError(`Continue start is unconfirmed. Read the original Session; no operation was resent. ${error instanceof Error ? error.message : String(error)}`,
            reopening ? 'AGENT_REOPEN_UNCONFIRMED' : 'AGENT_RESUME_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null },
            error instanceof AgentMuxError ? error.logId : undefined, { operationId: lifecycleOperationId, disposition: 'unknown' },
            error instanceof AgentMuxError ? error.storageFailure : undefined)
          Object.defineProperty(failure, 'cause', { value: error })
          throw failure
        }
        if (continuity) await this.settleContinuityMessageInput(continuity, { outcome: 'not-applied' })
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
          const rejected = new AgentMuxError('The original Run stopped; replacement Start was confirmed not applied. Check or explicitly retry the same original restart.',
            'AGENT_RESTART_START_NOT_APPLIED', undefined, { disposition: 'unknown', confirmedInputBytes: null },
            error.logId, error.creationFailure, error.storageFailure)
          Object.defineProperty(rejected, 'cause', { value: error })
          throw rejected
        }
        throw error
      })
      if (continuity) await this.settleContinuityMessageInput(continuity, { outcome: 'launch-carried', run: runRef(run.runId) })
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
        nativeBinding: { source: hasSelectedNativeTarget(current) ? 'user-selected' : 'semantic-resume-target', run: runRef(run.runId), observedAt: nativeBindingObservedAt }
      }
      if (continuity?.operationId === input.operationId && continuity.kind === 'starting') {
        next.continuity = { ...continuity, kind: 'resumed', newRun: { ...next.run }, observedAt: Date.now() }
        // Initialization/front-end recovery controls the previous Run's actor.
        // The successor has its own actor; carrying these controls rejects its commit.
        delete next.continuity.initializationRecovery
        delete next.continuity.frontendReconnect
        if (run.acceptedInputBytes !== null) next.continuity.resumedInputBoundary = { initialInputByte: run.acceptedInputBytes }
        if (restartReservation || resolutionHandoff) { delete next.continuity.errorCode; delete next.continuity.error }
        bindContinuityLaunchInput(next.continuity, next.run)
        const recoveryDelivery = createContinuityInputDelivery(next.continuity, run.acceptedInputBytes ?? undefined)
        if (recoveryDelivery) next.continuity.recoveryDelivery = recoveryDelivery
        next.continuityOperations = { ...(reservation.kind === 'resume' ? reservation.preparedSession?.continuityOperations : previous?.continuityOperations), [input.operationId]: next.continuity }
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
          } catch { preserveUnconfirmedRun = true; this.ports.hooks.retainBinding(lifecycleOperationId, hookBinding!) }
          throw failure
        }
        const rollbackErrors: unknown[] = [failure]
        try {
          await this.ports.hooks.closeRunBinding(run.runId, hookBinding!)
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
              if (canonical && canonical.run.runId === run.runId && (reopening ? canonical.reopenedFrom && canonical.reopenedFrom.observedAt === retirement!.observedAt &&
                canonical.reopenedFrom.run.runId === retirement!.run.runId : canonical.continuity?.operationId === input.operationId && canonical.continuity.newRun?.runId === run.runId)) {
                await this.ports.sessions.registry.load('local')
                persisted = this.ports.sessions.registry.get(current.agentSessionId)
              }
            } catch (readError) {
              // Unknown commit acknowledgement cannot authorize stopping a possibly committed healthy Run.
              preserveUnconfirmedRun = true
              this.ports.hooks.retainBinding(lifecycleOperationId, hookBinding)
              throw new AggregateError([error, readError], 'Continue result is unconfirmed. Read the same Session; no operation was resent.')
            }
          }
          if (persisted) {
            this.ports.hooks.activateBinding(run.runId, hookBinding, lifecycleOperationId)
            readySession = this.ports.sessions.registry.get(current.agentSessionId)
            if (!hookBound) this.ports.hooks.observeHookRestoreFailure(readySession, 'binding', error)
            let observationError: unknown = error
            if (recoveredCommit) {
              try {
                await hookBinding.bindRun(run.runId)
                hookBound = true
                this.ports.hooks.activateBinding(run.runId, hookBinding, lifecycleOperationId)
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
            this.ports.hooks.retainBinding(lifecycleOperationId, hookBinding)
            if (reservation.kind !== 'resume') throw error
            if (next.continuity) {
              next.continuity = { ...next.continuity, reason: 'operation-unconfirmed',
                error: `The original resume commit is unconfirmed. Keep its Run and inspect the same operation. ${error instanceof Error ? error.message : String(error)}` }
              next.continuityOperations = { ...next.continuityOperations, [input.operationId]: next.continuity }
            }
            readySession = await this.ports.sessions.registry.rememberStartedResume(reservation, next)
            await this.restoreReopenObservation(readySession, run, lifecycleOperationId)
            hookBound = this.ports.hooks.hasActiveBinding(run.runId)
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
      if (hookBound) this.ports.hooks.activateBinding(run.runId, hookBinding)
      this.ports.runtime.recordRunTransition(current.run, run)
      this.ports.terminal.queueNativeIdentityCapture(readySession, input)
      this.ports.events.publishSession(readySession)
      await this.ports.events.publishCurrentRunState(readySession)
      if (preserveUnconfirmedRun) return this.ports.events.projectSession(readySession)
      // The existing message owner either received this launch or remains waiting
      // for its ordinary post-launch rejoin. Recovery never submits a second input.
      if (continuity?.messageInput) return this.ports.events.projectSession(readySession)
      // A deferred input receipt must precede the history's delivery status. A healthy Run remains
      // available when input confirmation fails; the retained history must not claim it was sent.
      let promptConfirmed = false
      if (continuity?.launchInput?.delivery === 'post-launch') {
        readySession = await this.reconciler.settleContinuityPostLaunchInput(readySession, input.operationId)
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
      if (hookBinding && !preserveUnconfirmedRun) {
        try {
          await this.ports.hooks.releaseUnusedBinding(hookBinding, lifecycleOperationId, Boolean(persisted))
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        if (restartReservation && !preserveUnconfirmedRun && !persisted) this.ports.hooks.forgetPendingBinding(lifecycleOperationId)
        if (!preserveUnconfirmedRun && !restartReservation && (!resolutionHandoff || reservation.reservationId !== resolutionHandoff.reservation.reservationId)) {
          if (!persisted || hookBound) this.ports.hooks.forgetPendingBinding(lifecycleOperationId)
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

  /** Explicit manual recovery owns only retirement of this exact frozen Start; all observers stay read-only. */
  async resolvePreparedResume(input: AgentMuxAgentContinuityInput,
    original: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>): Promise<AgentMuxAgentContinuityResult> {
    const { ports } = this
    let reservation = original
    let ownsResolution = false
    const result = (session: AgentMuxStoredAgentSession): AgentMuxAgentContinuityResult => {
      const continuity = session.continuityOperations?.[input.operationId] ?? session.continuity!
      if (continuity.kind === 'resumed' && continuity.newRun && sameRun(continuity.newRun, session.run) && session.nativeHandle?.kind === 'provider') return {
        kind: 'resumed', session: ports.events.projectSession(session), previousRun: { ...input.expectedRun }, run: { ...session.run },
        evidence: { kind: 'provider-native', providerId: session.providerId, nativeSessionId: session.nativeHandle.sessionId,
          previousRun: continuity.evidence as AgentMuxAgentContinuityRunEvidence }, continuity: structuredClone(continuity) }
      return { kind: 'pending', agentSessionId: session.agentSessionId, previousRun: { ...input.expectedRun },
        reason: 'operation-unconfirmed', evidence: { kind: 'run-unknown', observedAt: Date.now(),
          message: continuity.error ?? 'The original prepared Start and explicit resolution are retained. Retry the same manual operation.' }, continuity: structuredClone(continuity) }
    }
    if (input.input !== undefined || input.messageInputRef !== undefined || input.timingOverride !== undefined) throw new AgentMuxError(
      'An unknown Start resolution cannot consume a new prompt or timing override. Preserve that input for its own operation.', 'AGENT_RESUME_RESOLUTION_REQUIRED')
    try {
      // A retained Run needs no fence. A new manual request still retains its safe relation to that exact original Start.
      const retained = await this.inspectPreparedResume(reservation)
      if (retained) {
        if (!reservation.resolution && reservation.preparedDispatch && input.trigger === 'manual' &&
            input.operationId !== reservation.preparedSession?.continuity?.operationId) {
          reservation = await ports.sessions.registry.admitResumeResolution(reservation, resumeResolutionRequest(input))
          ownsResolution = true
        }
        const completed = await this.completeObservedPreparedResume(reservation, retained)
        if (completed) return result(completed)
      }
      if (reservation.resolution && (input.trigger !== 'manual' || input.operationId !== reservation.resolution.receipt.operationId)) {
        return result(await ports.sessions.registry.refresh(input.agentSessionId, input.expectedRun))
      }
      if (input.trigger !== 'manual' || input.operationId === reservation.preparedSession?.continuity?.operationId) {
        return result(await ports.sessions.registry.refresh(input.agentSessionId, input.expectedRun))
      }
      if (!reservation.preparedDispatch || !retainedRunEnd(reservation.preparedSession)) throw new AgentMuxError(
        'The original dispatch source or exact original Run end is unconfirmed. Preserve the original operation and obtain its authoritative source.',
        'AGENT_RESUME_SOURCE_UNCONFIRMED')
      let request = resumeResolutionRequest(input)
      if (reservation.resolution) {
        const identityOnly = !['args', 'env', 'commandOverride', 'cols', 'rows'].some(key => Object.hasOwn(input, key))
        if (identityOnly) request = structuredClone(reservation.resolution.request)
        if (resumeResolutionDigest(request) !== reservation.resolution.receipt.requestDigest) throw new AgentMuxError(
          'The admitted manual resolution has a different frozen request. Retry its unchanged original operation.', 'AGENT_RESUME_RESOLUTION_CONFLICT')
      }
      reservation = await ports.sessions.registry.admitResumeResolution(reservation, request)
      ownsResolution = true
      ports.events.publishSession(ports.sessions.registry.get(input.agentSessionId))
      if (this.signal.aborted) return result(ports.sessions.registry.get(input.agentSessionId))
      const dispatch = reservation.preparedDispatch!
      const observed = await ports.runtime.kernel.observePreparedStartRetirement(reservation.operationId, dispatch.runtime)
      // Durable admission is authorization to redrive this same idempotent fence after a pre-send crash.
      const retirement = observed.outcome === 'retired' ? observed : await ports.runtime.kernel.retirePreparedStart(
        decodePreparedRun(dispatch.prepared).request, reservation.operationId, dispatch.runtime)
      if (retirement.outcome === 'retained') {
        const retained = await this.completeObservedPreparedResume(reservation, retirement.run)
        if (!retained) throw new AgentMuxError('The retained original Run could not be confirmed again. Its operation was kept.', 'AGENT_RESUME_UNCONFIRMED')
        return result(retained)
      }
      await this.resumeAgentRun({ ...request, prompt: '' }, request.expectedRun, undefined, undefined, undefined, undefined,
        { reservation, runtime: retirement.runtime })
      return result(ports.sessions.registry.get(input.agentSessionId))
    } catch (error) {
      const canonical = await ports.sessions.store.readMetadata(input.agentSessionId)
      if (!canonical || error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED) throw error
      // The Store checks the exact pending owner and Run atomically. A late failure cannot demote a completed successor.
      if (ownsResolution && reservation.resolution) {
        const updated = await ports.sessions.store.recordResumeResolutionFailure(reservation, {
          code: error instanceof AgentMuxError ? error.code : 'AGENT_RESUME_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) })
        await ports.sessions.registry.refresh(input.agentSessionId, updated.run)
        ports.events.publishSession(updated)
        return result(updated)
      }
      if (canonical.continuity?.resolution && (canonical.continuity.operationId === input.operationId ||
          error instanceof AgentMuxError && ['AGENT_SESSION_BUSY', 'AGENT_RESUME_RESOLUTION_CONFLICT'].includes(error.code))) return result(canonical)
      throw error
    } finally {
      // A healthy Core is not proof that this invocation is still executing. Release only its exact resolution owner.
      if (ownsResolution) await ports.sessions.store.releaseResumeResolutionOwner(reservation)
    }
  }

  private async inspectPreparedResume(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>): Promise<CtxmuxAdapterRun | null> {
    const dispatch = reservation.preparedDispatch
    if (!dispatch) {
      // A legacy reservation cannot authorize a negative conclusion or a fence on today's Runtime.
      // Its original secret binding can still recognize an accurately retained positive witness.
      const observed = await this.ports.runtime.kernel.inspectRetainedStart(reservation.operationId)
      if (!observed) throw new AgentMuxError(
        'The original resume dispatch Runtime and complete request were not retained by this Core owner, and this read-only key observation found no retained Run. Preserve the original Session and operation; obtain the original dispatch source or a matching retained Run. This observation does not authorize Start or retirement.',
        'AGENT_RESUME_SOURCE_UNCONFIRMED')
      assertPreparedResumeBinding(observed.prepared, reservation.preparedSession, reservation.operationId, 'AGENT_RESUME_RETAINED_MISMATCH')
      if (reservation.preparedSession?.run.runId !== reservation.expectedRun.runId) throw new AgentMuxError(
        'The original resume expected Run changed. Its Run and operation were preserved.', 'AGENT_RESUME_RETAINED_MISMATCH')
      // No reconstructed environment or persisted dispatch claim: settle the actual retained Run.
      return observed.run
    }
    return await this.ports.runtime.kernel.inspectPreparedStart(decodePreparedRun(dispatch.prepared).request,
      reservation.operationId, undefined, dispatch.runtime)
  }

  async completePreparedResume(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>): Promise<AgentMuxStoredAgentSession | null> {
    const run = await this.inspectPreparedResume(reservation)
    return run ? await this.completeObservedPreparedResume(reservation, run) : null
  }

  /** Only this owner calls this with a complete-spec witness from inspectPreparedResume or retirePreparedStart. */
  private async completeObservedPreparedResume(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, run: CtxmuxAdapterRun): Promise<AgentMuxStoredAgentSession | null> {
    const prepared = reservation.preparedSession
    if (!prepared || !run || run.lifecycleOperationId !== reservation.operationId) return null
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
      nativeBinding: { source: hasSelectedNativeTarget(prepared) ? 'user-selected' : 'semantic-resume-target', run: runRef(run.runId), observedAt } }
    for (const key of ['observedNativeHandle', 'nativeSourceObservation', 'nativePromptPredecessor', 'hookReceipt', 'terminalHandshake',
      'terminalCapability', 'terminalPromptReadiness', 'promptCompletionAdmission', 'terminalPromptSubmission', 'terminalPromptDelivery',
      'terminalOutputChannel', 'semanticStatus', 'pendingInteraction', 'recoveryActivity'] as const) delete next[key]
    if (prepared.continuity) {
      next.continuity = { ...structuredClone(prepared.continuity), kind: 'resumed', newRun: { ...next.run }, observedAt: Date.now() }
      delete next.continuity.initializationRecovery
      delete next.continuity.frontendReconnect
      if (!reservation.resolution && next.continuity.resolution?.operationId === next.continuity.operationId) {
        delete next.continuity.errorCode; delete next.continuity.error
      }
      const launched = next.continuity.launchInput
      if (launched && (!launched.launchPlan || launched.launchPlan.program !== run.program ||
          launched.launchPlan.argsDigest !== createHash('sha256').update(JSON.stringify(run.args)).digest('base64url'))) {
        throw new AgentMuxError('The original resume launch arguments are unconfirmed. The original Run and input are kept.', 'CONTINUITY_OPERATION_MISMATCH')
      }
      const messagePlan = next.continuity.messageInput?.plan
      if (messagePlan && (messagePlan.lifecycleOperationId !== reservation.operationId || messagePlan.program !== run.program ||
          messagePlan.argsDigest !== createHash('sha256').update(JSON.stringify(run.args)).digest('base64url') ||
          !matchesProviderNativeSessionTarget(messagePlan.nativeTarget, prepared.nativeHandle))) throw new AgentMuxError(
        'The original message launch arguments or native target are unconfirmed. No input was repeated.', 'CONTINUITY_OPERATION_MISMATCH')
      await this.settleContinuityMessageInput(next.continuity, { outcome: 'launch-carried', run: next.run })
      bindContinuityLaunchInput(next.continuity, next.run)
      const recoveryDelivery = createContinuityInputDelivery(next.continuity)
      if (recoveryDelivery) next.continuity.recoveryDelivery = recoveryDelivery
      delete next.continuity.nextActionAt
      next.continuityOperations = { ...prepared.continuityOperations, [prepared.continuity.operationId]: next.continuity }
    }
    if (reservation.resolution && next.continuity) {
      const originalReceipt = next.continuity
      const canonical = await this.ports.sessions.store.readMetadata(next.agentSessionId)
      const manual = canonical?.continuityOperations?.[reservation.resolution.receipt.operationId]
      if (!manual) throw new AgentMuxError('The original resolution admission is unavailable.', 'AGENT_RESUME_RESOLUTION_CONFLICT')
      const resolution = { ...reservation.resolution.receipt, outcome: 'retained' as const, retainedRun: { ...next.run } }
      next.continuity = { ...manual, kind: 'resumed', newRun: { ...next.run }, observedAt, resolution }
      delete next.continuity.error; delete next.continuity.errorCode
      next.continuityOperations = { ...next.continuityOperations, [originalReceipt.operationId]: { ...originalReceipt, resolution },
        [manual.operationId]: next.continuity }
    }
    try { await this.ports.sessions.registry.commitLifecycle(reservation, next) }
    catch (error) {
      const canonical = await this.ports.sessions.store.readMetadata(prepared.agentSessionId)
      if (canonical?.run.runId !== run.runId || canonical.continuity?.operationId !== next.continuity?.operationId) throw error
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
    if (carried?.delivery === 'post-launch' && prepared.continuity) {
      restored = await this.reconciler.settleContinuityPostLaunchInput(restored, prepared.continuity.operationId)
    }
    if (carried?.delivery === 'launch' && carried.state === 'launch-carried') {
      // The exact original Start is now known, so its frozen history can be
      // recorded under the same input ID without dispatching any input again.
      await this.ports.input.recordPromptMessageAfterSideEffect(restored, carried.input.submissionId, 'Resume prompt', carried.message)
    }
    this.ports.events.publisher.publish(lifecycleObserved(reservation, restored.run))
    return restored
  }
  async settle(): Promise<void> {
    await Promise.allSettled([...this.reopenSettlements.values(), ...this.restartSettlements.values()])
  }
}
