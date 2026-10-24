import { AgentMuxError, validateAgentPromptInputBinding, type AgentMuxClient,
  type AgentMuxAgentCreationInspection, type AgentMuxAgentRuntimeStatus, type AgentMuxClientEvent,
  type AgentMuxRunRef, type AgentMuxRun, type AgentMuxRpcCallContext, type AgentPromptInputBinding,
  type AgentInputSubmissionReceipt, type AgentPromptExecution, type AgentPromptPreparationRetryFence,
  type AgentMessageChannel, type AgentPromptSubmissionRecord, type AgentTimelineSnapshot,
  type ContinuousProgressObservation, type ContinuousProgressTarget, type ContinuousProgressLoop,
  type AgentScheduleCheckInPolicy } from '@agentmux/core'
import { AGENTMUX_AGENT_MESSAGING_ENTRY } from '@agentmux/core'
import { AGENT_SCHEDULE_CHECK_IN_GUIDANCE } from '@agentmux/core/schedule'
import type { AgentInputContextCaptureReference } from '@agentmux/core/agent-input-context-capture'
import type { DemandDispatch } from '@agentmux/demand'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { CheckInObservation } from './agent-schedule-check-in.js'

export type GoalAgentControl = { kind: 'agent'; hostId: string; agentSessionId: string; run: AgentMuxRunRef }
export type GoalDispatchReference = { goalId: string; operationId: string }
export type GoalExecutionClient = AgentMuxClient | AgentMuxHostedClient
type Automation = { completionId?: string; futureIntent?: { intentId: string; occurrenceAt: number };
  inputByte?: number; isCurrent(): boolean; signal: AbortSignal }
type Attention = { hostId: string; supervisorAgentSessionId: string; supervisorRunId: string; operationId: string; producer?: 'message' }

/** The existing Goal mechanisms borrow typed Core operations, never an editor controller. */
export interface GoalRuntimePort {
  agentCreation(hostId: string, agentSessionId: string): Promise<AgentMuxAgentCreationInspection>
  observeGoalAgent(hostId: string, agentSessionId: string): Promise<AgentMuxAgentRuntimeStatus>
  resolveGoalAgent(agentSessionId: string): Promise<{ hostId: string; status: AgentMuxAgentRuntimeStatus }>
  observeOriginalRun(hostId: string, runId: string): Promise<Pick<AgentMuxRun, 'runId' | 'state'>>
  observeCoreEvents(types: readonly AgentMuxClientEvent['type'][], listener: (hostId: string, event: AgentMuxClientEvent) => void): () => void
  observeInputOccupation(listener: (control: GoalAgentControl) => void): () => void
  observeContinuousProgress(target: ContinuousProgressTarget & { futureIntentId?: string }, tickId: string, now: number, signal?: AbortSignal): Promise<ContinuousProgressObservation>
  submitPrompt(control: GoalAgentControl, prompt: string, operationId: string, condition: AgentPromptInputBinding,
    automation?: Automation, choice?: { allowUncertainTurn?: true; execution?: AgentPromptExecution; preparationRetry?: AgentPromptPreparationRetryFence },
    authorHuman?: boolean, agentMuxNote?: string, sourceChannel?: AgentMessageChannel,
    inputContextCapture?: AgentInputContextCaptureReference, authority?: AgentMuxRpcCallContext): Promise<void | AgentInputSubmissionReceipt>
  sessionTimeline(target: { hostId: string; agentSessionId: string }): Promise<AgentTimelineSnapshot>
  saveGoalAttention(input: Attention & { intentId: string; agentMuxNote: string }): Promise<void>
  disableGoalAttention(input: Omit<Attention, 'supervisorRunId'> & { intentId: string; agentMuxNote: string }): Promise<void>
  inspectGoalAttention(input: Attention): Promise<AgentPromptSubmissionRecord | null>
  inspectGoalStart(input: DemandDispatch): Promise<AgentPromptSubmissionRecord | null>
  authorizeFutureIntent(target: ContinuousProgressTarget, context?: AgentMuxRpcCallContext): Promise<void>
  saveFutureIntent(loop: ContinuousProgressTarget & { futureIntentId?: string; creationOperationId?: string; prompt: string; checkIn?: AgentScheduleCheckInPolicy }, active: boolean, context?: AgentMuxRpcCallContext): Promise<void>
  observeCheckIn(target: ContinuousProgressTarget, now: number, signal: AbortSignal): Promise<CheckInObservation>
  inspectContinuousProgressInitial(loop: ContinuousProgressLoop): Promise<'confirmed' | 'pending' | 'unconfirmed'>
}

export function createGoalRuntime(options: {
  clients(): readonly { hostId: string; client: GoalExecutionClient }[]
  subscribeClients?(listener: () => void): () => void
  inputOccupied?(control: GoalAgentControl, signal?: AbortSignal): Promise<boolean>
  subscribeInputOccupation?(listener: (control: GoalAgentControl) => void): () => void
  checkIn(target: ContinuousProgressTarget, now: number, signal: AbortSignal): Promise<CheckInObservation>
}): GoalRuntimePort {
  const exact = (hostId: string) => {
    const matches = options.clients().filter(entry => entry.hostId === hostId)
    if (matches.length !== 1) throw new AgentMuxError('The original Goal execution Host is unavailable or ambiguous. Original input and healthy Agents are retained.', 'CONTROL_UNAVAILABLE')
    return matches[0]!.client
  }
  const status = async (hostId: string, sessionId: string) => {
    const client = exact(hostId), value = await client.statusAgent(sessionId)
    if (exact(hostId) !== client || value.session.agentSessionId !== sessionId || value.session.hostId !== 'local' && value.session.hostId !== hostId)
      throw new AgentMuxError('The original Goal execution owner changed during observation. Retain its exact Session and operation.', 'STALE_AGENT_SESSION')
    return { ...value, session: { ...value.session, hostId } }
  }
  const inspect = async (input: Attention) => await exact(input.hostId).inspectAgentPromptSubmission(input.producer === 'message'
    ? { kind: 'message', agentSessionId: input.supervisorAgentSessionId, expectedRun: { runId: input.supervisorRunId }, messageId: input.operationId }
    : { kind: 'prompt', agentSessionId: input.supervisorAgentSessionId, expectedRun: { runId: input.supervisorRunId }, submissionId: input.operationId })
  const runtime: GoalRuntimePort = {
    agentCreation: async (hostId, sessionId) => {
      const value = await exact(hostId).inspectAgentCreation(sessionId)
      if (value.agentSessionId !== sessionId) throw new AgentMuxError('The original Goal Agent identity changed.', 'STALE_AGENT_SESSION')
      return { ...value, hostId }
    },
    observeGoalAgent: status,
    resolveGoalAgent: async sessionId => {
      const matches = options.clients().filter(entry => { try { return entry.client.agentSession(sessionId).agentSessionId === sessionId } catch { return false } })
      if (matches.length !== 1) throw new AgentMuxError('The exact Goal Agent has no unique retained Host binding. Reconnect its original owner; no unrelated Host was probed.', 'CONTROL_UNAVAILABLE')
      return { hostId: matches[0]!.hostId, status: await status(matches[0]!.hostId, sessionId) }
    },
    observeOriginalRun: async (hostId, runId) => { const value = await exact(hostId).runtimeSubject({ kind: 'terminal-run', runId }); return { runId: value.run.runId, state: value.run.state } },
    observeCoreEvents: (types, listener) => {
      const selected = new Set(types), observed = new Map<string, { client: GoalExecutionClient; dispose(): void }>()
      const reconcile = () => {
        const entries = options.clients(), unique = entries.filter(entry => entries.filter(value => value.hostId === entry.hostId).length === 1)
        const desired = new Map(unique.map(entry => [entry.hostId, entry.client]))
        for (const [hostId, entry] of observed) if (desired.get(hostId) !== entry.client) { observed.delete(hostId); entry.dispose() }
        for (const [hostId, client] of desired) if (!observed.has(hostId)) {
          const dispose = client.onEvent(event => { if (observed.get(hostId)?.client === client && selected.has(event.type)) listener(hostId, event) })
          observed.set(hostId, { client, dispose })
        }
      }
      const release = options.subscribeClients?.(reconcile)
      reconcile()
      return () => { release?.(); for (const entry of observed.values()) entry.dispose(); observed.clear() }
    },
    observeInputOccupation: listener => options.subscribeInputOccupation?.(listener) ?? (() => {}),
    observeContinuousProgress: async (target, tickId, now, signal) => {
      signal?.throwIfAborted()
      const value = await status(target.hostId, target.agentSessionId)
      if (value.session.providerId !== target.providerId || value.session.workspacePath !== target.workspacePath)
        throw new AgentMuxError('The original Goal target resource changed. Original input remains available.', 'STALE_AGENT_SESSION')
      const inputOccupied = options.inputOccupied ? await options.inputOccupied({ kind: 'agent', hostId: target.hostId, agentSessionId: target.agentSessionId, run: value.session.run }, signal) : undefined
      const saved = target.futureIntentId ? await exact(target.hostId).readAgentFuturePromptIntent(target.agentSessionId, target.futureIntentId) : null
      signal?.throwIfAborted()
      return { session: target.futureIntentId ? { ...value.session, futurePromptIntents: saved ? { [target.futureIntentId]: saved } : {} } : value.session,
        observation: value.observation, inputByte: value.run.acceptedInputBytes, ...(inputOccupied === undefined ? {} : { inputOccupied }), tickId, now }
    },
    submitPrompt: async (control, prompt, operationId, condition, automation, choice, authorHuman, agentMuxNote, sourceChannel = 'message-tool', inputContextCapture, authority) => {
      authority?.signal?.throwIfAborted(); await authority?.assertCurrent?.()
      const binding = validateAgentPromptInputBinding(condition)
      if (binding.expectedRun.runId !== control.run.runId) throw new AgentMuxError('The original Goal input names another Run.', 'STALE_AGENT_SESSION')
      if (automation && !automation.isCurrent()) throw new AgentMuxError('The original automatic Goal input was cancelled. Manual input remains available.', 'AGENT_COMPLETION_CHANGED')
      automation?.signal.throwIfAborted()
      const signal = automation?.signal && authority?.signal ? AbortSignal.any([automation.signal, authority.signal]) : automation?.signal ?? authority?.signal
      const client = exact(control.hostId)
      const originalAuthority = authority && control.hostId === 'local' ? { assertCurrent: async () => { await authority.assertCurrent?.(); await runtime.authorizeFutureIntent({ ...control, providerId: client.agentSession(control.agentSessionId).providerId, workspacePath: client.agentSession(control.agentSessionId).workspacePath }, authority) } } : undefined
      const submit = (input: import('@agentmux/core').AgentMuxAgentPromptInput) => originalAuthority ? client.submitAgentPrompt(input, originalAuthority) : client.submitAgentPrompt(input)
      const content = { ...(signal ? { signal } : {}), agentSessionId: control.agentSessionId, prompt, operationId,
        ...(agentMuxNote === undefined ? {} : { agentMuxNote }), ...(authorHuman ? { authorHuman: true } : {}), sourceChannel,
        ...(inputContextCapture ? { inputContextCapture } : {}) }
      if ('admissionIntent' in binding) {
        if (automation || choice?.execution !== 'immediate' || choice.preparationRetry || choice.allowUncertainTurn) throw new AgentMuxError('The original automatic Goal input cannot become a new manual message.', 'INVALID_AGENT_PROMPT')
        return await submit({ ...content, ...binding, execution: 'immediate' })
      }
      return await submit({ ...content, ...binding,
        ...(automation ? { signal: automation.signal, ...(automation.futureIntent ? { expectedFutureIntent: automation.futureIntent } : automation.completionId === undefined ? {} : { expectedCompletionId: automation.completionId }), ...(automation.inputByte === undefined ? {} : { expectedInputByte: automation.inputByte }) } : {}),
        ...(!automation && choice?.execution ? { execution: choice.execution } : {}), ...(!automation && choice?.preparationRetry ? { preparationRetry: choice.preparationRetry } : {}),
        ...(!automation && choice?.allowUncertainTurn ? { allowUncertainTurn: true } : {}),
      })
    },
    sessionTimeline: async target => await exact(target.hostId).sessionTimeline(target.agentSessionId),
    saveGoalAttention: async input => {
      const observed = await status(input.hostId, input.supervisorAgentSessionId)
      if (observed.session.run.runId !== input.supervisorRunId) throw new AgentMuxError('The original Goal reminder Run changed; inspect its saved intent.', 'STALE_AGENT_SESSION')
      await exact(input.hostId).saveAgentFuturePromptIntent({ agentSessionId: input.supervisorAgentSessionId, intentId: input.intentId,
        operationId: input.operationId, prompt: '', agentMuxNote: input.agentMuxNote, active: true, expectedRun: { runId: input.supervisorRunId } })
    },
    disableGoalAttention: async input => {
      const client = exact(input.hostId), original = await client.readAgentFuturePromptIntent(input.supervisorAgentSessionId, input.intentId)
      if (original && (original.operationId !== input.operationId || original.message.systemContext !== input.agentMuxNote)) throw new AgentMuxError('The original Goal reminder intent differs from this request.', 'CONTROL_REQUEST_CONFLICT')
      if (original) await client.saveAgentFuturePromptIntent({ agentSessionId: input.supervisorAgentSessionId, intentId: input.intentId,
        operationId: input.operationId, prompt: '', agentMuxNote: input.agentMuxNote, active: false })
    },
    inspectGoalAttention: inspect,
    inspectGoalStart: async input => await inspect({ hostId: input.hostId, supervisorAgentSessionId: input.agentSessionId, supervisorRunId: input.runId, operationId: input.operationId }),
    authorizeFutureIntent: async (target, context) => {
      context?.signal?.throwIfAborted(); await context?.assertCurrent?.()
      if (!context?.caller) return
      const client = exact(target.hostId), recipient = await status(target.hostId, target.agentSessionId)
      const sender = await client.authorizeAgentCaller(context.caller.capability, context.caller.agentSessionId)
      await client.authorizeAgentMessage({ capability: context.caller.capability, callerAgentSessionId: sender.agentSessionId,
        senderAgentSessionId: sender.agentSessionId, senderSessionId: sender.agentSessionId, senderRunId: sender.run.runId,
        recipientSessionId: recipient.session.agentSessionId, recipientRunId: recipient.session.run.runId })
    },
    saveFutureIntent: async (loop, active, context) => {
      await runtime.authorizeFutureIntent(loop, context)
      const client = exact(loop.hostId), observed = await status(loop.hostId, loop.agentSessionId)
      if (observed.session.providerId !== loop.providerId || observed.session.workspacePath !== loop.workspacePath || !loop.futureIntentId || !loop.creationOperationId)
        throw new AgentMuxError('The original future-message target or intent is unconfirmed. Manual input remains available.', 'STALE_AGENT_SESSION')
      const original = await client.readAgentFuturePromptIntent(loop.agentSessionId, loop.futureIntentId)
      if (original && (original.operationId !== loop.creationOperationId || original.message.userContent !== loop.prompt)) throw new AgentMuxError('The original future-message content changed. Inspect that saved arrangement.', 'AGENT_FUTURE_INTENT_CHANGED')
      await context?.assertCurrent?.()
      const agentMuxNote = original ? original.message.systemContext : AGENTMUX_AGENT_MESSAGING_ENTRY + (loop.checkIn ? '\n\n' + AGENT_SCHEDULE_CHECK_IN_GUIDANCE : '')
      await client.saveAgentFuturePromptIntent({ agentSessionId: loop.agentSessionId, intentId: loop.futureIntentId, operationId: loop.creationOperationId,
        expectedRun: observed.session.run,
        prompt: loop.prompt, ...(agentMuxNote === undefined ? {} : { agentMuxNote }),
        active, ...(context?.caller ? { caller: context.caller } : {}) })
    },
    observeCheckIn: options.checkIn,
    inspectContinuousProgressInitial: async loop => {
      const initial = loop.initialDelivery
      if (!initial) return 'unconfirmed'
      const original = await inspect({ hostId: loop.hostId, supervisorAgentSessionId: loop.agentSessionId, supervisorRunId: initial.condition.expectedRun.runId, operationId: initial.operationId })
      const admission = original?.admission, key = admission?.inputKey
      if (original?.agentSessionId !== loop.agentSessionId || original.run.runId !== initial.condition.expectedRun.runId || key?.kind !== 'prompt' || key.agentSessionId !== loop.agentSessionId || key.expectedRun.runId !== initial.condition.expectedRun.runId || key.submissionId !== initial.operationId || admission?.submissionId !== initial.operationId || admission.intent?.message?.userContent !== initial.prompt) return 'unconfirmed'
      return admission.acknowledged === true || original.terminalPromptSubmission?.submissionId === initial.operationId && original.terminalPromptSubmission.submit.acknowledged === true ? 'confirmed' : 'pending'
    }
  }
  return runtime
}
