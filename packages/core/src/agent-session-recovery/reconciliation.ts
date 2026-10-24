import { parseTerminalFrontendObservation, type AgentTerminalFrontendObservation, type AgentTerminalFrontendRecoveryRequest } from '../agent-terminal-frontend.js'
import { observePromptInput } from '../prompt-submission.js'
import { observeResumedTurnInterruption } from './resumed-interruption.js'
import type { AgentSessionContinuityInputs } from './input.js'
import { isDeepStrictEqual } from 'node:util'
import { matchesProviderNativeSessionTarget } from '../agent-native-locator.js'
import { agentPromptNotApplied } from '../agent-prompt-condition.js'
import { sameRun } from '../agent-session-identity.js'
import { type CtxmuxAdapterRun } from '../ctxmux-run-adapter.js'
import { AgentMuxError } from '../errors.js'
import type { AgentMuxStoredAgentSession } from '../types.js'
import { terminalHandshakeOperationIdentity, terminalInitialPromptReadinessIdentity } from '../agent-runtime-helpers.js'
import type { AgentSessionRecoveryPorts } from './ports.js'

/** Reconciles original Provider/Runtime facts; cannot start, stop or retire a Run. */
export class AgentSessionRecoveryReconciler {
  private readonly resumedInterruptionReads = new Map<string, Promise<AgentMuxStoredAgentSession>>()
  private readonly providerReads = new Set<AbortController>()
  private readonly initialInputContinuations = new Map<string, Promise<void>>()
  constructor(
    private readonly ports: Pick<AgentSessionRecoveryPorts, 'sessions' | 'providers' | 'input' | 'terminal' | 'events' | 'observations' | 'connection'> & {
      runtime: Pick<AgentSessionRecoveryPorts['runtime'], 'assertAgentRun' | 'requireCurrentAgentRun'> & {
        kernel: Pick<AgentSessionRecoveryPorts['runtime']['kernel'], 'status'>
      }
    },
    private readonly continuityInputs: Pick<AgentSessionContinuityInputs, 'track'>,
    private readonly signal: AbortSignal
  ) {}

  async observeResumedInterruption(session: AgentMuxStoredAgentSession): Promise<AgentMuxStoredAgentSession> {
    const active = Object.values(session.continuityOperations ?? {}).find(op => op.kind === 'resumed' && op.newRun?.runId === session.run.runId)
    if (!active || active.recoveryDelivery || active.resumedInterruption || this.signal.aborted) return session
    const key = JSON.stringify([session.agentSessionId, session.run.runId, active.operationId])
    const existing = this.resumedInterruptionReads.get(key)
    if (existing) return await existing
    const controller = new AbortController(), epoch = this.ports.connection.connectionEpoch
    this.providerReads.add(controller)
    const unregisterRead = this.ports.observations.registerProviderRead(controller)
    const pending = observeResumedTurnInterruption(session, {
      provider: this.ports.providers.providers.get(session.providerId), signal: controller.signal,
      status: async () => { const run = await this.ports.runtime.kernel.status(session.run.runId); this.ports.runtime.assertAgentRun(session, run, [session]); return run },
      save: async change => {
        if (controller.signal.aborted || epoch !== this.ports.connection.connectionEpoch || this.signal.aborted) return session
        const updated = await this.ports.sessions.updateExactAgentSession(session.agentSessionId, session.run, change)
        if (!isDeepStrictEqual(updated.continuityOperations, session.continuityOperations)) {
          this.ports.events.publishSession(updated); this.continuityInputs.track(updated)
        }
        return updated
      }
    }).catch(error => {
      if (!controller.signal.aborted && epoch === this.ports.connection.connectionEpoch && !this.signal.aborted) this.ports.events.publisher.publish({
        type: 'agent-error', agentSessionId: session.agentSessionId, code: 'AGENT_CONTINUITY_OBSERVATION_UNCONFIRMED',
        message: `The original recovered turn is unconfirmed. Its Session, healthy Run and ordinary input remain available. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
      return session
    }).finally(() => { this.providerReads.delete(controller); unregisterRead(); if (this.resumedInterruptionReads.get(key) === pending) this.resumedInterruptionReads.delete(key) })
    this.resumedInterruptionReads.set(key, pending)
    return await pending
  }

  async exactRecoverySession(session: AgentMuxStoredAgentSession, operationId?: string, automatic = false): Promise<AgentMuxStoredAgentSession | null> {
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

  async recoverOriginalFrontend(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun,
    request: AgentTerminalFrontendRecoveryRequest, ownerOperationId = request.operationId): Promise<AgentTerminalFrontendObservation> {
    const controller = new AbortController()
    this.providerReads.add(controller); const unregisterRead = this.ports.observations.registerProviderRead(controller)
    try {
      const assertRequest = async (): Promise<void> => {
        const exact = !this.signal.aborted && await this.exactRecoverySession(session, ownerOperationId)
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
        processId: run.pid!, nativeActor: session.nativeActor!, workspacePath: session.workspacePath, signal: controller.signal,
        ...(session.nativeHandle ? { nativeHandle: session.nativeHandle } : {}), assertCurrent: assertRequest
      }, request))
      await assertRequest()
      return parseTerminalFrontendObservation(observed)
    } finally { this.providerReads.delete(controller); unregisterRead() }
  }

  async assertRecoveryInputCurrent(session: AgentMuxStoredAgentSession, operationId?: string, automatic = false): Promise<void> {
    if (this.signal.aborted || !await this.exactRecoverySession(session, operationId, automatic)) throw new AgentMuxError(
      'The original recovery input was cancelled before dispatch. Its key and retained input remain available.', 'AGENT_CONTINUITY_SUPERSEDED')
  }

  async bindInitializedNativeSession(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun,
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

  async acceptRecoveredFrontend(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun,
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

  observeInitialInput(session: AgentMuxStoredAgentSession): void {
    if (this.signal.aborted) return
    const input = session.initialInput
    const controlled = Boolean(session.nativeActor?.initializationControl)
    const retained = controlled ? Object.values(session.continuityOperations ?? {}).filter(operation => operation.launchInput?.delivery === 'post-launch' &&
      operation.launchInput.key?.expectedRun.runId === session.run.runId && !['native-admitted', 'terminal-confirmed', 'not-applied'].includes(operation.launchInput.state)) : []
    const initial = (controlled || input?.delivery === 'post-launch') && input?.key?.expectedRun.runId === session.run.runId && !['native-admitted', 'terminal-confirmed', 'not-applied'].includes(input.state)
    if (!initial && !retained.length) return
    const key = JSON.stringify([session.agentSessionId, session.run, session.nativeActor?.actorId ?? null, initial ? input?.key : null, retained.map(value => value.operationId)])
    if (this.initialInputContinuations.has(key)) return
    const work = (async () => {
      if (controlled) await this.ports.terminal.ensureTerminalFrontendObservation(session)
      let current = await this.ports.sessions.registry.refresh(session.agentSessionId, session.run)
      if (this.signal.aborted) return
      const run = await this.ports.runtime.requireCurrentAgentRun(current)
      if (controlled) {
        const frontend = this.ports.terminal.readFrontendObservation(session.agentSessionId)
        if (!frontend || !sameRun(frontend.run, current.run) || frontend.initialization?.phase !== 'ready') return
        current = await this.bindInitializedNativeSession(current, run, frontend)
      }
      const exact = await this.exactRecoverySession(current, undefined, true)
      if (!this.signal.aborted && exact) {
        if (initial) await this.ports.input.continueInitialInput(exact, run, () => this.assertRecoveryInputCurrent(exact, undefined, true))
        for (const operation of retained) await this.settleContinuityPostLaunchInput(this.ports.sessions.registry.get(session.agentSessionId), operation.operationId)
      }
    })().catch(error => {
      if (!this.signal.aborted) this.ports.events.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: 'AGENT_INITIAL_INPUT_UNCONFIRMED', message: `The original initialization input is retained. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
    }).finally(() => { if (this.initialInputContinuations.get(key) === work) this.initialInputContinuations.delete(key) })
    this.initialInputContinuations.set(key, work)
  }

  async settleContinuityPostLaunchInput(session: AgentMuxStoredAgentSession, operationId: string): Promise<AgentMuxStoredAgentSession> {
    const input = session.continuityOperations?.[operationId]?.launchInput
    if (!input?.key || input.delivery !== 'post-launch' || ['terminal-confirmed', 'native-admitted', 'not-applied'].includes(input.state)) return session
    const run = await this.ports.runtime.requireCurrentAgentRun(session)
    let nativeSource: { providerId: string; nativeSessionId: string } | undefined
    if (session.nativeActor?.initializationControl) {
      await this.ports.terminal.ensureTerminalFrontendObservation(session)
      const frontend = this.ports.terminal.readFrontendObservation(session.agentSessionId), initialization = frontend?.initialization
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
  async dispose(): Promise<void> {
    for (const controller of this.providerReads) controller.abort()
    this.initialInputContinuations.clear()
    await Promise.allSettled(this.resumedInterruptionReads.values())
  }
}
