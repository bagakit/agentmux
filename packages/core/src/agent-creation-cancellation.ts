import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import type { AgentMuxRunRef } from './types.js'

export type AgentCreationCancellationInput = { createOperationId: string; agentSessionId: string; operationId: string }
export type AgentCreationCancellation = AgentCreationCancellationInput & { runtimeId: string }
export type AgentCreationCancellationResult = {
  cancellation: AgentCreationCancellation | null
  outcome: 'cancelled' | 'created' | 'unconfirmed'
  run: AgentMuxRunRef | null
  initialInput: 'held' | 'already-dispatched' | 'unknown'
  diskDurability: 'confirmed' | 'unconfirmed'
  issue: string | null
}
export function parseAgentCreationCancellation(value: unknown): AgentCreationCancellationInput {
  const p = rpcRecord(value, ['createOperationId', 'agentSessionId', 'operationId'])
  const result = { createOperationId: rpcString(p.createOperationId, 'Original creation'),
    agentSessionId: rpcString(p.agentSessionId, 'Original created Session'), operationId: rpcString(p.operationId, 'Original cancellation') }
  if (result.operationId === result.createOperationId) throw new AgentMuxError('Cancellation needs a distinct original operation.', 'INVALID_CONTROL_REQUEST')
  return result
}
export function parseAgentCreationCancellationResult(value: unknown, input: AgentCreationCancellationInput, runtimeId: string): AgentCreationCancellationResult {
  const p = rpcRecord(value, ['cancellation','outcome','run','initialInput','diskDurability','issue'], 'CONTROL_PROTOCOL_ERROR')
  if (!['cancelled','created','unconfirmed'].includes(String(p.outcome)) || !['held','already-dispatched','unknown'].includes(String(p.initialInput)) ||
    !['confirmed','unconfirmed'].includes(String(p.diskDurability)) || p.issue !== null && typeof p.issue !== 'string') throw new AgentMuxError('The original creation cancellation result is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
  if (p.cancellation !== null) {
    const c=rpcRecord(p.cancellation,['createOperationId','agentSessionId','operationId','runtimeId'],'CONTROL_PROTOCOL_ERROR')
    if(c.createOperationId!==input.createOperationId||c.agentSessionId!==input.agentSessionId||c.operationId!==input.operationId||c.runtimeId!==runtimeId) throw new AgentMuxError('The cancellation receipt names another original creation or Runtime.', 'CONTROL_PROTOCOL_ERROR')
  } else if(p.outcome!=='unconfirmed') throw new AgentMuxError('No original cancellation receipt confirms this result.', 'CONTROL_PROTOCOL_ERROR')
  if(p.run!==null)rpcString(rpcRecord(p.run,['runId']).runId,'Original created Run')
  if(p.outcome==='created'&&p.run===null||p.outcome==='cancelled'&&p.run!==null)throw new AgentMuxError('The original cancellation has inconsistent Run facts.', 'CONTROL_PROTOCOL_ERROR')
  return structuredClone(p) as AgentCreationCancellationResult
}
export function parseAgentCreationCancellationRecord(value: unknown): AgentCreationCancellation {
  try {
    const p=rpcRecord(value,['createOperationId','agentSessionId','operationId','runtimeId'])
    return {...parseAgentCreationCancellation({createOperationId:p.createOperationId,agentSessionId:p.agentSessionId,operationId:p.operationId}),runtimeId:rpcString(p.runtimeId,'Original cancellation Runtime')}
  } catch {
    throw new AgentMuxError('The original execution cancellation record is unconfirmed.', 'AGENT_CREATION_CANCELLATION_UNCONFIRMED')
  }
}
