import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export type AgentAutomationTarget = { agentSessionId: string; expectedRun: { runId: string }; ownerInstanceId: string; operationId: string }
export type AgentAutomationPause = AgentAutomationTarget
export type AgentAutomationPauseReceipt = AgentAutomationTarget & {
  status: 'confirmed' | 'unknown'
  pausedLoopIds: string[]
  disabledIntentIds: string[]
  issues: Array<{ stage: string; message: string }>
}
export type AgentAutomationPauseInspection = { target: AgentAutomationTarget; receipt: AgentAutomationPauseReceipt | null; retention: 'owner-instance' }
export interface AgentAutomationOwner {
  pause(input: AgentAutomationPause, context: import('./public-rpc-service.js').AgentMuxRpcCallContext): Promise<AgentAutomationPauseInspection>
  inspect(input: AgentAutomationTarget, context: import('./public-rpc-service.js').AgentMuxRpcCallContext): Promise<AgentAutomationPauseInspection>
}
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)
export function parseAgentAutomationTarget(value: unknown): AgentAutomationTarget {
  const p = rpcRecord(value, ['agentSessionId', 'expectedRun', 'ownerInstanceId', 'operationId'])
  const run = rpcRecord(p.expectedRun, ['runId'])
  if (!id(p.agentSessionId) || !id(p.ownerInstanceId) || !id(p.operationId) || !id(run.runId)) throw new AgentMuxError('Automatic input pause requires its exact original owner, Session, Run and operation.', 'INVALID_CONTROL_REQUEST')
  return { agentSessionId: p.agentSessionId, expectedRun: { runId: run.runId }, ownerInstanceId: p.ownerInstanceId, operationId: p.operationId }
}
export function parseAgentAutomationInspection(value: unknown, input: AgentAutomationTarget): AgentAutomationPauseInspection {
  const p = rpcRecord(value, ['target', 'receipt', 'retention'])
  const target = parseAgentAutomationTarget(p.target)
  const matches = (v: AgentAutomationTarget) => v.agentSessionId === input.agentSessionId && v.expectedRun.runId === input.expectedRun.runId && v.ownerInstanceId === input.ownerInstanceId && v.operationId === input.operationId
  if (!matches(target) || p.retention !== 'owner-instance') throw new AgentMuxError('Automatic input pause observation returned another original target.', 'CONTROL_PROTOCOL_ERROR')
  if (p.receipt === null) return { target, receipt: null, retention: 'owner-instance' }
  const r = rpcRecord(p.receipt, ['agentSessionId', 'expectedRun', 'ownerInstanceId', 'operationId', 'status', 'pausedLoopIds', 'disabledIntentIds', 'issues'])
  const identity = parseAgentAutomationTarget({ agentSessionId: r.agentSessionId, expectedRun: r.expectedRun, ownerInstanceId: r.ownerInstanceId, operationId: r.operationId })
  if (!matches(identity) || !['confirmed', 'unknown'].includes(String(r.status)) || !Array.isArray(r.pausedLoopIds) || !r.pausedLoopIds.every(id) || !Array.isArray(r.disabledIntentIds) || !r.disabledIntentIds.every(id) || !Array.isArray(r.issues) || !r.issues.every(issue => { const item = rpcRecord(issue, ['stage', 'message']); return id(item.stage) && typeof item.message === 'string' }))
    throw new AgentMuxError('Automatic input pause receipt is unconfirmed. Retain the original operation; manual input remains available.', 'CONTROL_PROTOCOL_ERROR')
  return { target, receipt: { ...identity, status: r.status as 'confirmed' | 'unknown', pausedLoopIds: r.pausedLoopIds, disabledIntentIds: r.disabledIntentIds, issues: r.issues as AgentAutomationPauseReceipt['issues'] }, retention: 'owner-instance' }
}
