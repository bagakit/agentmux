import type { AgentMuxClient,
  AgentMuxAgentCreationInspection, AgentMuxAgentRuntimeStatus, AgentMuxClientEvent,
  AgentMuxRunRef, AgentMuxRun, AgentMuxRpcCallContext, AgentPromptInputBinding,
  AgentInputSubmissionReceipt, AgentPromptExecution, AgentPromptPreparationRetryFence,
  AgentMessageChannel, AgentPromptSubmissionRecord, AgentTimelineSnapshot,
  ContinuousProgressObservation, ContinuousProgressTarget, ContinuousProgressLoop,
  AgentScheduleCheckInPolicy } from '@agentmux/core'
import type { AgentInputContextCaptureReference } from '@agentmux/core/agent-input-context-capture'
import type { DemandDispatch } from '@agentmux/demand'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { CheckInObservation } from './agent-schedule-check-in.js'

export type GoalAgentControl = { kind: 'agent'; hostId: string; agentSessionId: string; run: AgentMuxRunRef }
export type GoalDispatchReference = { goalId: string; operationId: string }
export type GoalExecutionClient = AgentMuxClient | AgentMuxHostedClient
type Automation = { completionId?: string; futureIntent?: { intentId: string; occurrenceAt: number };
  inputByte?: number; isCurrent(): boolean; signal: AbortSignal }
type Attention = { hostId: string; supervisorAgentSessionId: string; supervisorRunId: string; operationId: string }

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
