import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'
import type { AgentMuxInteractionOperationReceipt } from './types.js'

export type GoalApprovalSelection = { goalId: string; dispatchOperationId: string }
export type GoalApprovalAuthority = GoalApprovalSelection & {
  inputKey: Extract<AgentPromptInputKey, { kind: 'prompt' }>
  actor: { kind: 'user' | 'device'; id: string }
}
export type GoalApprovalAttribution = GoalApprovalAuthority & { kind: 'explicit-goal-selection'; at: number }
export type GoalApprovalObservation = {
  operationId: string; requestId: string; attribution: GoalApprovalAttribution
  decision: 'approved' | 'denied' | 'cancelled' | 'recorded'
  delivery: AgentMuxInteractionOperationReceipt['delivery']; nativeCompleted: boolean
}

export function parseGoalApprovalSelection(value: unknown): GoalApprovalSelection {
  const source = rpcRecord(value, ['goalId', 'dispatchOperationId'])
  return { goalId: rpcString(source.goalId, 'Original Goal ID'), dispatchOperationId: rpcString(source.dispatchOperationId, 'Original Start operation') }
}

export function parseGoalApprovalAttribution(value: unknown): GoalApprovalAttribution {
  const source = rpcRecord(value, ['kind', 'goalId', 'dispatchOperationId', 'inputKey', 'actor', 'at'])
  const selection = parseGoalApprovalSelection({ goalId: source.goalId, dispatchOperationId: source.dispatchOperationId })
  const actor = rpcRecord(source.actor, ['kind', 'id']), inputKey = validateAgentPromptInputKey(source.inputKey as AgentPromptInputKey)
  if (source.kind !== 'explicit-goal-selection' || inputKey.kind !== 'prompt' || inputKey.attemptId !== undefined ||
      actor.kind !== 'user' && actor.kind !== 'device' || !Number.isSafeInteger(source.at) || Number(source.at) < 0)
    throw new AgentMuxError('Original explicit approval attribution is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return { ...selection, kind: 'explicit-goal-selection', inputKey, actor: { kind: actor.kind, id: rpcString(actor.id, 'Original approval author') }, at: Number(source.at) }
}

export function goalApprovalObservation(receipt: AgentMuxInteractionOperationReceipt): GoalApprovalObservation | undefined {
  if (!receipt.goalApproval || receipt.response.kind !== 'permission' || receipt.expectedRequest.kind !== 'permission') return undefined
  const decision = receipt.response.decision
  const option = decision.outcome === 'selected' ? receipt.expectedRequest.options.find(item => item.id === decision.optionId) : undefined
  return { operationId: receipt.operationId, requestId: receipt.expectedRequest.id, attribution: receipt.goalApproval,
    decision: decision.outcome === 'cancelled' ? 'cancelled' : option?.kind.startsWith('allow-') ? 'approved'
      : option?.kind.startsWith('reject-') ? 'denied' : 'recorded',
    delivery: receipt.delivery, nativeCompleted: Boolean(receipt.nativeCompleted) }
}

export function parseGoalApprovalObservation(value: unknown): GoalApprovalObservation {
  const source = rpcRecord(value, ['operationId', 'requestId', 'attribution', 'decision', 'delivery', 'nativeCompleted'])
  if (typeof source.nativeCompleted !== 'boolean' || !['approved', 'denied', 'cancelled', 'recorded'].includes(String(source.decision)) ||
      !['saved', 'unknown', 'bytes-accepted', 'hook-written', 'acp-acknowledged'].includes(String(source.delivery)))
    throw new AgentMuxError('Original approval observation is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return { operationId: rpcString(source.operationId, 'Original approval operation'), requestId: rpcString(source.requestId, 'Original permission request'),
    attribution: parseGoalApprovalAttribution(source.attribution), decision: source.decision as GoalApprovalObservation['decision'],
    delivery: source.delivery as GoalApprovalObservation['delivery'], nativeCompleted: source.nativeCompleted }
}
