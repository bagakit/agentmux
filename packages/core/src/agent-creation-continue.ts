import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Original creation CID in this trusted Core owner; a known SID is an additional fence. */
export type AgentMuxCreationContinueInput = { createOperationId: string; agentSessionId?: string }
/** A scheduling receipt only. It never confirms storage, Start or input delivery. */
export type AgentMuxCreationContinueReceipt = AgentMuxCreationContinueInput & { status: 'woken' | 'not-waiting' | 'unknown' }

function id(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value) }
export function parseCreationContinueInput(value: unknown): AgentMuxCreationContinueInput {
  const input = rpcRecord(value, ['createOperationId', 'agentSessionId'])
  if (!id(input.createOperationId) || input.agentSessionId !== undefined && !id(input.agentSessionId)) {
    throw new AgentMuxError('Continuing a creation requires its complete original operation and optional exact Session.', 'INVALID_CONTROL_REQUEST')
  }
  return { createOperationId: input.createOperationId, ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }) }
}
export function parseCreationContinueReceipt(value: unknown, input: AgentMuxCreationContinueInput): AgentMuxCreationContinueReceipt {
  const receipt = rpcRecord(value, ['createOperationId', 'agentSessionId', 'status'], 'CONTROL_PROTOCOL_ERROR')
  if (receipt.createOperationId !== input.createOperationId || typeof receipt.status !== 'string' || !['woken', 'not-waiting', 'unknown'].includes(receipt.status) ||
      receipt.agentSessionId !== undefined && !id(receipt.agentSessionId) ||
      input.agentSessionId !== undefined && (receipt.agentSessionId !== undefined && receipt.agentSessionId !== input.agentSessionId ||
        receipt.status !== 'unknown' && receipt.agentSessionId !== input.agentSessionId)) {
    throw new AgentMuxError('Creation continuation returned another original target or malformed scheduling receipt.', 'CONTROL_PROTOCOL_ERROR')
  }
  return structuredClone(receipt) as AgentMuxCreationContinueReceipt
}

export type AgentMuxCreationContinueParams = AgentMuxCreationContinueInput & { hostId: string }
export type AgentMuxCreationContinueResult = AgentMuxCreationContinueReceipt & { hostId: string }
export function parseCreationContinueParams(value: unknown): AgentMuxCreationContinueParams {
  const params = rpcRecord(value, ['hostId', 'createOperationId', 'agentSessionId'])
  if (!id(params.hostId)) throw new AgentMuxError('Creation continuation requires the exact original Host.', 'INVALID_CONTROL_REQUEST')
  const { hostId, ...request } = params
  return { hostId, ...parseCreationContinueInput(request) }
}
export function parseCreationContinueResult(value: unknown, input: AgentMuxCreationContinueParams): AgentMuxCreationContinueResult {
  const result = rpcRecord(value, ['hostId', 'createOperationId', 'agentSessionId', 'status'], 'CONTROL_PROTOCOL_ERROR')
  if (result.hostId !== input.hostId) throw new AgentMuxError('Creation continuation returned another Host.', 'CONTROL_PROTOCOL_ERROR')
  const { hostId, ...receipt } = result
  return { hostId: input.hostId, ...parseCreationContinueReceipt(receipt, input) }
}
