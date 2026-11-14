import { optionalInputEpoch, agentPromptNotApplied } from '@agentmux/core/prompt-condition'
import { awaitUntilCancelled } from './await-until-cancelled.js'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { GoalQualifiedAccess, GoalInspectionAccess } from '@agentmux/core/control'
import type { DemandQualifiedDispatchIntent } from '@agentmux/demand'
import type { AgentInputSubmissionReceipt, AgentInputWaitRef } from '@agentmux/core'

import { AutomaticInputNotDispatchedError } from './automatic-input-not-dispatched.js'
import { sameAutomaticInputSource } from '@agentmux/core/automatic-input-source'
import { MOTE_INPUT_GUIDANCE } from '@agentmux/core/mote-input-source'
import { AgentMuxError, decideContinuousProgress, validateAgentPromptInputBinding, type AgentMuxClient,
  type AgentMuxAgentSession, type AgentMuxAgentCreationInspection, type AgentMuxAgentRuntimeStatus, type AgentMuxClientEvent,
  type AgentMuxRunRef, type AgentMuxRun, type AgentMuxRpcCallContext, type AgentPromptInputBinding,
  type AgentPromptExecution, type AgentPromptPreparationRetryFence,
  type AgentMessageChannel, type AgentPromptSubmissionRecord, type AgentTimelineSnapshot,
  type ContinuousProgressObservation, type ContinuousProgressTarget, type ContinuousProgressLoop,
  type AgentScheduleCheckInPolicy } from '@agentmux/core'
import { AGENTMUX_AGENT_MESSAGING_ENTRY } from '@agentmux/core'
import { AGENT_SCHEDULE_CHECK_IN_GUIDANCE } from '@agentmux/core/schedule'
import type { AgentInputContextCaptureReference } from '@agentmux/core/agent-input-context-capture'
import type { DemandDispatch } from '@agentmux/demand'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { CheckInObservation } from './agent-schedule-check-in.js'
import { readOriginalScheduledHistory, readOriginalScheduledInput } from './scheduled-input-source.js'

/** One explicit Goal operation borrows this exact original input carrier. */
export type GoalFiniteInputPort = {
  readCurrent(): Promise<{ runId: string; inputEpoch?: string }>
  submit(input: DemandQualifiedDispatchIntent): Promise<AgentInputSubmissionReceipt>
  inspectOriginal(input: DemandQualifiedDispatchIntent): Promise<AgentInputSubmissionReceipt | null>
  rejoinOriginal(input: DemandQualifiedDispatchIntent, ref: AgentInputWaitRef): Promise<AgentInputSubmissionReceipt>
  dispose(): Promise<void>
}
export type GoalFiniteInspectionPort = Pick<GoalFiniteInputPort, 'inspectOriginal' | 'dispose'>
export type GoalFiniteInspectionInput = { reference: DemandSpaceMemberReference; access: GoalInspectionAccess; originalRunId: string }
export type GoalFiniteAccessInput = { reference: DemandSpaceMemberReference; access: GoalQualifiedAccess; originalRunId?: string }

export type GoalAgentControl = { kind: 'agent'; hostId: string; agentSessionId: string; run: AgentMuxRunRef }
export type GoalDispatchReference = { goalId: string; operationId: string; inputEpoch?: string }
export type GoalExecutionClient = AgentMuxClient | AgentMuxHostedClient
type Automation = { completionId?: string; futureIntent?: { intentId: string; occurrenceAt: number };
  inputByte?: number; isCurrent(): boolean; signal: AbortSignal }
type Attention = { inputEpoch?: string; hostId: string; supervisorAgentSessionId: string; supervisorRunId: string; operationId: string; producer?: 'message' }

/** The existing Goal mechanisms borrow typed Core operations, never an editor controller. */
export interface GoalRuntimePort {
  openFinite(input: GoalFiniteAccessInput, context: AgentMuxRpcCallContext): Promise<GoalFiniteInputPort>
  openFiniteInspection(input: GoalFiniteInspectionInput, context: AgentMuxRpcCallContext): Promise<GoalFiniteInspectionPort>
  spatialCreationCandidates(tabId: string, regionId: string): Promise<AgentMuxAgentSession[]>
  readInputEpoch(hostId: string): Promise<string | undefined>
  agentCreation(hostId: string, agentSessionId: string): Promise<AgentMuxAgentCreationInspection>
  observeGoalAgent(hostId: string, agentSessionId: string): Promise<AgentMuxAgentRuntimeStatus>
  locateGoalAgentHost(agentSessionId: string, expectedHostId?: string): string
  resolveGoalAgent(agentSessionId: string, expectedHostId?: string): Promise<{ hostId: string; status: AgentMuxAgentRuntimeStatus }>
  observeOriginalRun(hostId: string, runId: string): Promise<Pick<AgentMuxRun, 'runId' | 'state'>>
  observeCoreEvents(types: readonly AgentMuxClientEvent['type'][], listener: (hostId: string, event: AgentMuxClientEvent) => void): () => void
  observeInputOccupation(listener: (control: GoalAgentControl) => void): () => void
  observeContinuousProgress(target: ContinuousProgressTarget & { futureIntentId?: string }, tickId: string, now: number, signal?: AbortSignal): Promise<ContinuousProgressObservation>
  submitPrompt(control: GoalAgentControl, prompt: string, operationId: string, condition: AgentPromptInputBinding,
    automation?: Automation, choice?: { allowUncertainTurn?: true; execution?: AgentPromptExecution; preparationRetry?: AgentPromptPreparationRetryFence },
    authorHuman?: boolean, agentMuxNote?: string, sourceChannel?: AgentMessageChannel,
    inputContextCapture?: AgentInputContextCaptureReference, authority?: AgentMuxRpcCallContext): ReturnType<AgentMuxClient['submitAgentPrompt']>
  sessionTimeline(target: { hostId: string; agentSessionId: string }): Promise<AgentTimelineSnapshot>
  saveGoalAttention(input: Attention & { intentId: string; agentMuxNote: string }): Promise<void>
  disableGoalAttention(input: Omit<Attention, 'supervisorRunId'> & { intentId: string; agentMuxNote: string }): Promise<void>
  inspectGoalAttention(input: Attention): Promise<AgentPromptSubmissionRecord | null>
  inspectGoalStart(input: DemandDispatch): Promise<AgentPromptSubmissionRecord | null>
  authorizeFutureIntent(target: ContinuousProgressTarget, context?: AgentMuxRpcCallContext): Promise<void>
  saveFutureIntent(loop: ContinuousProgressTarget & Pick<ContinuousProgressLoop, 'futureIntentId' | 'creationOperationId' | 'managedSource' | 'prompt' | 'checkIn' | 'currentDefinition' | 'guidanceAdoptions' | 'inputEpoch'>, active: boolean, context?: AgentMuxRpcCallContext): Promise<void>
  inspectFutureIntent(loop: ContinuousProgressLoop): Promise<{ active: boolean }>
  inspectInput(loop: ContinuousProgressLoop): Promise<import('@agentmux/core').ContinuousProgressInputReading | undefined>
  supersededInputWasUnclaimed(loop: ContinuousProgressLoop, signal: AbortSignal): Promise<boolean>
  readHistory?(loop: ContinuousProgressLoop, query: import('@agentmux/core').ScheduleHistoryQuery, context?: AgentMuxRpcCallContext): ReturnType<typeof readOriginalScheduledHistory>
  observeCheckIn(target: ContinuousProgressTarget, now: number, signal: AbortSignal): Promise<CheckInObservation>
  inspectContinuousProgressInitial(loop: ContinuousProgressLoop): Promise<'confirmed' | 'pending' | 'unconfirmed'>
}

export function createGoalRuntime(options: {
  openFinite?(input: GoalFiniteAccessInput, context: AgentMuxRpcCallContext): Promise<GoalFiniteInputPort>
  openFiniteInspection?(input: GoalFiniteInspectionInput, context: AgentMuxRpcCallContext): Promise<GoalFiniteInspectionPort>
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
  const locateGoalAgentHost = (sessionId: string, expectedHostId?: string) => {
    const matches = options.clients().filter(entry => {
      if (expectedHostId !== undefined && entry.hostId !== expectedHostId) return false
      try { return entry.client.agentSession(sessionId).agentSessionId === sessionId } catch { return false }
    })
    if (matches.length !== 1) throw new AgentMuxError('The exact Goal Agent has no unique retained Host binding. Reconnect its original owner; no unrelated Host was probed.', 'CONTROL_UNAVAILABLE')
    return matches[0]!.hostId
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
    openFinite: async (input, context) => {
      if (!options.openFinite) throw new AgentMuxError('The current Source access for this finite Goal input is unavailable. Its original request and Agent remain retained.', 'CONTROL_UNAVAILABLE')
      return await options.openFinite(input, context)
    },
    openFiniteInspection: async (input, context) => {
      if (!options.openFiniteInspection) throw new AgentMuxError('The original qualified Goal input reader is unavailable. Its request and Agent remain retained.', 'CONTROL_UNAVAILABLE')
      return await options.openFiniteInspection(input, context)
    },
    spatialCreationCandidates: async (tabId, regionId) => {
      const clients = options.clients()
      if (!clients.length) throw new AgentMuxError('The original Core creation owners are unavailable. Keep the Launcher and request.', 'CONTROL_UNAVAILABLE')
      const candidates = await Promise.all(clients.map(async ({ hostId, client }) => {
        if (exact(hostId) !== client) throw new AgentMuxError('The original Core creation Host is ambiguous.', 'CONTROL_UNAVAILABLE')
        const sessions = await client.readAgentSessions()
        if (exact(hostId) !== client) throw new AgentMuxError('The original Core creation owner changed while reading.', 'CONTROL_UNAVAILABLE')
        const matched = sessions.filter(session => session.creation?.spatialIntent?.tabId === tabId && session.creation.spatialIntent.regionId === regionId)
        if (matched.some(session => session.hostId !== 'local' && session.hostId !== hostId)) throw new AgentMuxError('The original creation metadata names another Core owner.', 'CONTROL_UNAVAILABLE')
        return matched.map(session => ({ ...session, hostId }))
      }))
      return candidates.flat()
    },
    agentCreation: async (hostId, sessionId) => {
      const client = exact(hostId), value = await client.inspectAgentCreation(sessionId)
      if (exact(hostId) !== client) throw new AgentMuxError('The original Core creation owner changed during observation. Its Goal and Session remain retained.', 'STALE_AGENT_SESSION')
      if (value.agentSessionId !== sessionId || value.hostId !== 'local' && value.hostId !== hostId) throw new AgentMuxError('The original Goal Agent identity changed.', 'STALE_AGENT_SESSION')
      return { ...value, hostId }
    },
    observeGoalAgent: status,
    readInputEpoch: hostId => exact(hostId).readAgentInputEpoch(),
    locateGoalAgentHost,
    resolveGoalAgent: async (sessionId, expectedHostId) => {
      const hostId = locateGoalAgentHost(sessionId, expectedHostId)
      return { hostId, status: await status(hostId, sessionId) }
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
      const base: ContinuousProgressObservation = { session: value.session, observation: value.observation,
        inputByte: value.run.acceptedInputBytes, ...(inputOccupied === undefined ? {} : { inputOccupied }), tickId, now }
      const decision = decideContinuousProgress(base)
      const needsInitialObservation = target.futureIntentId && decision.kind === 'skip' && decision.reason === 'unknown-status' &&
        base.inputByte !== null && base.observation.process === 'running' && base.observation.readiness === 'ready' &&
        (base.session.promptCompletionAdmission === undefined || agentPromptNotApplied(base.session))
      const futureInputActivity = needsInitialObservation ? await exact(target.hostId).readAgentInputActivity({ kind: 'prompt',
        agentSessionId: target.agentSessionId, expectedRun: value.session.run, submissionId: tickId }) : undefined
      signal?.throwIfAborted()
      return { ...base, session: target.futureIntentId ? { ...value.session, futurePromptIntents: saved ? { [target.futureIntentId]: saved } : {} } : value.session,
        ...(futureInputActivity === undefined ? {} : { futureInputActivity }), tickId, now }
    },
    submitPrompt: async (control, prompt, operationId, condition, automation, choice, authorHuman, agentMuxNote, sourceChannel = 'message-tool', inputContextCapture, authority) => {
      let dispatchStarted = false
      try {
        authority?.signal?.throwIfAborted(); await authority?.assertCurrent?.()
        const binding = validateAgentPromptInputBinding(condition)
        if (binding.expectedRun.runId !== control.run.runId) throw new AgentMuxError('The original Goal input names another Run.', 'STALE_AGENT_SESSION')
        if (automation && !automation.isCurrent()) throw new AgentMuxError('The original automatic Goal input was cancelled. Manual input remains available.', 'AGENT_COMPLETION_CHANGED')
        automation?.signal.throwIfAborted()
        const signal = automation?.signal && authority?.signal ? AbortSignal.any([automation.signal, authority.signal]) : automation?.signal ?? authority?.signal
        const client = exact(control.hostId)
        const originalAuthority = authority && control.hostId === 'local' ? { assertCurrent: async () => { await authority.assertCurrent?.(); await runtime.authorizeFutureIntent({ ...control, providerId: client.agentSession(control.agentSessionId).providerId, workspacePath: client.agentSession(control.agentSessionId).workspacePath }, authority) } } : undefined
        const submit = (input: import('@agentmux/core').AgentMuxAgentPromptInput) => {
          const dispatch = () => {
            automation?.signal.throwIfAborted()
            dispatchStarted = true
            return originalAuthority ? client.submitAgentPrompt(input, originalAuthority) : client.submitAgentPrompt(input)
          }
          // A cancelled Host wait cannot recall an entered Core operation. Its original receipt stays unknown.
          return automation ? awaitUntilCancelled(dispatch, automation.signal) : dispatch()
        }
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
      } catch (error) {
        if (automation && !dispatchStarted) throw new AutomaticInputNotDispatchedError(error)
        throw error
      }
    },
    sessionTimeline: async target => await exact(target.hostId).sessionTimeline(target.agentSessionId),
    saveGoalAttention: async input => {
      const observed = await status(input.hostId, input.supervisorAgentSessionId)
      if (observed.session.run.runId !== input.supervisorRunId) throw new AgentMuxError('The original Goal reminder Run changed; inspect its saved intent.', 'STALE_AGENT_SESSION')
      await exact(input.hostId).saveAgentFuturePromptIntent({ agentSessionId: input.supervisorAgentSessionId, intentId: input.intentId,
        operationId: input.operationId, ...optionalInputEpoch(input.inputEpoch), prompt: '', agentMuxNote: input.agentMuxNote, active: true, expectedRun: { runId: input.supervisorRunId } })
    },
    disableGoalAttention: async input => {
      const client = exact(input.hostId), original = await client.readAgentFuturePromptIntent(input.supervisorAgentSessionId, input.intentId)
      if (original && (original.operationId !== input.operationId || original.message.systemContext !== input.agentMuxNote)) throw new AgentMuxError('The original Goal reminder intent differs from this request.', 'CONTROL_REQUEST_CONFLICT')
      if (original) await client.saveAgentFuturePromptIntent({ agentSessionId: input.supervisorAgentSessionId, intentId: input.intentId,
        operationId: input.operationId, prompt: '', agentMuxNote: input.agentMuxNote, active: false })
    },
    inspectGoalAttention: inspect,
    inspectGoalStart: async input => {
      if ('target' in input) throw new AgentMuxError('Read this original qualified Goal input through its current Source access.', 'CONTROL_UNAVAILABLE')
      return await inspect({ hostId: input.hostId, supervisorAgentSessionId: input.agentSessionId, supervisorRunId: input.runId, operationId: input.operationId })
    },
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
      const operationId = loop.currentDefinition?.operationId ?? loop.creationOperationId
      if (loop.currentDefinition && loop.currentDefinition.intentId !== loop.futureIntentId || original && (original.operationId !== operationId || original.message.userContent !== loop.prompt)) throw new AgentMuxError('The original future-message content changed. Inspect that saved arrangement.', 'AGENT_FUTURE_INTENT_CHANGED')
      await context?.assertCurrent?.()
      let agentMuxNote = original ? original.message.systemContext : AGENTMUX_AGENT_MESSAGING_ENTRY + (loop.managedSource ? '\n\n' + MOTE_INPUT_GUIDANCE + '\nInternal maintenance source: ' + JSON.stringify(loop.managedSource) : '') + (loop.checkIn ? '\n\n' + AGENT_SCHEDULE_CHECK_IN_GUIDANCE : '')
      if (loop.currentDefinition) {
        const definition = loop.currentDefinition, adoption = loop.guidanceAdoptions?.find(value => value.newDefinition.intentId === definition.intentId && value.newDefinition.operationId === definition.operationId)
        const base = await client.readAgentFuturePromptIntent(loop.agentSessionId, definition.baseIntentId)
        if (!adoption || adoption.newDefinition.guidanceRevision !== definition.guidanceRevision || !base || base.operationId !== loop.creationOperationId || base.message.userContent !== loop.prompt || !sameAutomaticInputSource(base.continuitySource, loop.managedSource)) throw new AgentMuxError('The original guidance base or frozen adoption is unconfirmed. Its original inputs remain retained.', 'AGENT_FUTURE_INTENT_CHANGED')
        agentMuxNote = (base.message.systemContext ?? '') + '\n\n' + adoption.guidance
      }
      await client.saveAgentFuturePromptIntent({ agentSessionId: loop.agentSessionId, intentId: loop.futureIntentId, operationId,
        expectedRun: observed.session.run, ...(loop.managedSource ? { continuitySource: loop.managedSource } : {}),
        prompt: loop.prompt, ...(agentMuxNote === undefined ? {} : { agentMuxNote }),
        ...optionalInputEpoch(loop.inputEpoch),active, ...(context?.caller ? { caller: context.caller } : {}) })
    },
    inspectFutureIntent: async loop => {
      const client = exact(loop.hostId), session = client.agentSession(loop.agentSessionId)
      const original = loop.futureIntentId ? await client.readAgentFuturePromptIntent(loop.agentSessionId, loop.futureIntentId) : null
      const operationId = loop.currentDefinition?.operationId ?? loop.creationOperationId
      if (session.kind !== 'agent' || session.providerId !== loop.providerId || session.workspacePath !== loop.workspacePath || !original || original.operationId !== operationId || original.message.userContent !== loop.prompt || !sameAutomaticInputSource(original.continuitySource, loop.managedSource))
        throw new AgentMuxError('The original future definition cannot be confirmed. Keep this operation for inspection.', 'AGENT_FUTURE_INTENT_CHANGED')
      if (loop.currentDefinition) {
        const definition = loop.currentDefinition, adoption = loop.guidanceAdoptions?.find(value => value.newDefinition.intentId === definition.intentId && value.newDefinition.operationId === definition.operationId)
        const base = await client.readAgentFuturePromptIntent(loop.agentSessionId, definition.baseIntentId)
        if (definition.intentId !== loop.futureIntentId || !adoption || !base || base.operationId !== loop.creationOperationId || base.message.userContent !== loop.prompt || !sameAutomaticInputSource(base.continuitySource, loop.managedSource) || original.message.systemContext !== (base.message.systemContext ?? '') + '\n\n' + adoption.guidance)
          throw new AgentMuxError('The exact original guidance content is unconfirmed. Its saved intent is retained.', 'AGENT_FUTURE_INTENT_CHANGED')
      }
      return { active: original.active }
    },
    inspectInput: async loop => readOriginalScheduledInput(loop, exact(loop.hostId)),
    supersededInputWasUnclaimed: async (loop, signal) => {
      const { lastInputRef: reference, providerId, workspacePath, pendingCompletion } = loop
      if (!reference || !pendingCompletion?.condition) return false
      return await exact(loop.hostId).supersededScheduledInputWasUnclaimed({ reference, providerId, workspacePath,
        ...optionalInputEpoch(pendingCompletion.condition.inputEpoch) }, { signal })
    },
    readHistory: async (loop, query, context) => {
      const client = exact(loop.hostId)
      const page = await readOriginalScheduledHistory(loop, query, client, context?.signal)
      if (exact(loop.hostId) !== client) throw new AgentMuxError('The original schedule execution owner changed during observation.', 'CONTROL_UNAVAILABLE')
      return page
    },
    observeCheckIn: options.checkIn,
    inspectContinuousProgressInitial: async loop => {
      const initial = loop.initialDelivery
      if (!initial) return 'unconfirmed'
      // The loop's frozen target must still be the same Agent at the same place: a different
      // provider or workspace is another execution, whatever its input receipt says.
      const session = exact(loop.hostId).agentSession(loop.agentSessionId)
      if (session.kind !== 'agent' || session.agentSessionId !== loop.agentSessionId || session.providerId !== loop.providerId || session.workspacePath !== loop.workspacePath) return 'unconfirmed'
      const original = await inspect({ hostId: loop.hostId, supervisorAgentSessionId: loop.agentSessionId, supervisorRunId: initial.condition.expectedRun.runId, operationId: initial.operationId })
      const admission = original?.admission, key = admission?.inputKey
      if (original?.agentSessionId !== loop.agentSessionId || original.run.runId !== initial.condition.expectedRun.runId || key?.kind !== 'prompt' || key.agentSessionId !== loop.agentSessionId || key.expectedRun.runId !== initial.condition.expectedRun.runId || key.submissionId !== initial.operationId || admission?.submissionId !== initial.operationId || admission.intent?.message?.userContent !== initial.prompt) return 'unconfirmed'
      return admission.acknowledged === true || original.terminalPromptSubmission?.submissionId === initial.operationId && original.terminalPromptSubmission.submit.acknowledged === true ? 'confirmed' : 'pending'
    }
  }
  return runtime
}
