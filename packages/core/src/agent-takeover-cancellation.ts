import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import type { AgentMuxRpcParams } from './public-rpc.js'
import type { AgentMuxRunRef } from './types.js'
import type { AgentMuxSpaceAddress } from './space-control.js'

/** expectedRuntimeId is the original spatial admission Core, never the source Agent Runtime. */
export type AgentTakeoverCancellationInput = {
  expectedRuntimeId: string
  operationId: string
  request: AgentMuxRpcParams<'agent.open'> & { operationId: string }
}
export type AgentTakeoverCancellationResult = {
  owner: { runtimeId: string; ownerInstanceId: string }
  operationId: string
  createOperationId: string
  /** Exact cancellation admission at the original spatial owner. Omitted by older owners means unknown. */
  cancellationAdmission?: 'observed' | 'not-observed'
  outcome: 'cancelled' | 'created' | 'unconfirmed'
  /** hostId belongs to the original spatial owner's namespace, not the observing client. */
  agent: { agentSessionId: string; run: AgentMuxRunRef | null; hostId: string; runtimeId: string } | null
  to: AgentMuxSpaceAddress | null
  initialInput: 'held' | 'already-dispatched' | 'unknown'
  diskDurability: 'confirmed' | 'unconfirmed'
  issue: string | null
}
export * from './agent-creation-cancellation.js'
export function parseAgentTakeoverCancellation(value: unknown): AgentTakeoverCancellationInput {
  const p = rpcRecord(value, ['expectedRuntimeId', 'operationId', 'request'])
  const request = rpcRecord(p.request, ['operationId','destination','content','focus'])
  rpcRecord(request.destination)
  const content = rpcRecord(request.content)
  if (request.focus !== undefined && typeof request.focus !== 'boolean' || content.kind !== 'takeover-agent') throw new AgentMuxError('Cancel the exact original Takeover request.', 'INVALID_CONTROL_REQUEST')
  const operationId = rpcString(p.operationId, 'Original cancellation')
  if (operationId === rpcString(request.operationId, 'Original Takeover')) throw new AgentMuxError('Cancellation needs a distinct original operation.', 'INVALID_CONTROL_REQUEST')
  return { expectedRuntimeId: rpcString(p.expectedRuntimeId, 'Original spatial Runtime'), operationId,
    request: structuredClone(p.request) as AgentMuxRpcParams<'agent.open'> & { operationId: string } }
}
export function parseAgentTakeoverCancellationResult(value: unknown, input: AgentTakeoverCancellationInput): AgentTakeoverCancellationResult {
  const p = rpcRecord(value, ['owner','operationId','createOperationId','cancellationAdmission','outcome','agent','to','initialInput','diskDurability','issue'], 'CONTROL_PROTOCOL_ERROR')
  const owner = rpcRecord(p.owner, ['runtimeId','ownerInstanceId'], 'CONTROL_PROTOCOL_ERROR')
  if (owner.runtimeId !== input.expectedRuntimeId || p.operationId !== input.operationId || p.createOperationId !== input.request.operationId ||
    !['cancelled','created','unconfirmed'].includes(String(p.outcome)) || !['held','already-dispatched','unknown'].includes(String(p.initialInput)) ||
    !['confirmed','unconfirmed'].includes(String(p.diskDurability)) || p.issue !== null && typeof p.issue !== 'string') throw new AgentMuxError('The cancellation result belongs to another original intent or owner.', 'CONTROL_PROTOCOL_ERROR')
  rpcString(owner.ownerInstanceId, 'Original owner instance')
  if (p.cancellationAdmission !== undefined && p.cancellationAdmission !== 'observed' && p.cancellationAdmission !== 'not-observed' ||
    p.cancellationAdmission === 'not-observed' && p.outcome !== 'unconfirmed')
    throw new AgentMuxError('The cancellation admission observation is inconsistent with its result.', 'CONTROL_PROTOCOL_ERROR')
  if (p.agent !== null) {
    const a = rpcRecord(p.agent, ['agentSessionId','run','hostId','runtimeId'], 'CONTROL_PROTOCOL_ERROR')
    for (const key of ['agentSessionId','hostId','runtimeId']) rpcString(a[key], 'Original created Agent')
    if (a.run !== null) rpcString(rpcRecord(a.run, ['runId']).runId, 'Original created Run')
  }
  if (p.to !== null) { const to = rpcRecord(p.to); for (const key of ['workspaceId','displayWorkspaceId','groupId','tabId','regionId']) rpcString(to[key], 'Original placement'); if (to.spaceId !== null) rpcString(to.spaceId, 'Original Space'); if (to.zoneId !== null) rpcString(to.zoneId, 'Original Zone') }
  if (p.outcome === 'created' && p.agent === null || p.outcome === 'cancelled' && p.agent !== null) throw new AgentMuxError('The cancellation result has inconsistent creation facts.', 'CONTROL_PROTOCOL_ERROR')
  return structuredClone(p) as AgentTakeoverCancellationResult
}
