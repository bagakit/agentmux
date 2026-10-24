import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import type { AgentMuxRpcGoal } from './public-rpc.js'
/** Confirm existing Core input provenance. This operation creates no input or Session. */
export type GoalParticipationConfirm = {
  goalId: string
  creationOperationId?: string
  hostId: string
  agentSessionId: string
  expectedRun: { runId: string }
  evidence: 'creation-input' | 'prompt-input' | 'message-input'
  operationId: string
}
export type GoalParticipationReceipt = { goal: AgentMuxRpcGoal; operationId: string; diskDurability: 'confirmed' }
export type GoalParticipationOwner = { confirm(input: GoalParticipationConfirm, context: AgentMuxRpcCallContext): Promise<GoalParticipationReceipt> }
export function parseGoalParticipationConfirm(value: unknown): GoalParticipationConfirm {
  const p = rpcRecord(value, ['goalId','creationOperationId','hostId','agentSessionId','expectedRun','evidence','operationId'])
  const run = rpcRecord(p.expectedRun, ['runId'])
  const valid = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\0\r\n]/u.test(v)
  if (![p.goalId,p.hostId,p.agentSessionId,p.operationId,run.runId].every(valid) || p.creationOperationId !== undefined && !valid(p.creationOperationId) ||
      p.evidence !== 'creation-input' && p.evidence !== 'prompt-input' && p.evidence !== 'message-input') throw new AgentMuxError('Goal participation requires its exact original Goal, Host, Session, Run, input evidence and operation.', 'INVALID_CONTROL_REQUEST')
  return { goalId: p.goalId as string, hostId: p.hostId as string, agentSessionId: p.agentSessionId as string,
    operationId: p.operationId as string, expectedRun: { runId: run.runId as string }, evidence: p.evidence,
    ...(p.creationOperationId === undefined ? {} : { creationOperationId: p.creationOperationId as string }) }
}
