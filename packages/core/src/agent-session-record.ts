import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** A terminal fact on the original retired row; it is never authority over a Run or native file. */
export type AgentSessionRecordDeletion = { operationId: string; retirementRevision: string; deletedAt: number; phase: 'pending' | 'complete' }
export type AgentSessionRecordDeletionEvent = { type: 'agent-session-record-deleted'; agentSessionId: string; retiredAt: number; recordDeletion: AgentSessionRecordDeletion }
export type AgentSessionRecordInput = { hostId: string; agentSessionId: string; operationId?: string }
export type AgentSessionRecordDeleteInput = AgentSessionRecordInput & {
  operationId: string
  expectedRetiredAt: number
  expectedRetirementRevision: string
  /** Explicit completion of already confirmed cleanup, never an unknown-result replay. */
  continue?: true
}
export type AgentSessionRecordDeletionReceipt = {
  hostId: string
  agentSessionId: string
  retiredAt: number
  deletion: AgentSessionRecordDeletion
  persistence: 'confirmed'
}
export type AgentSessionRecordInspection = { hostId: string; agentSessionId: string; observedAt: number } & (
  | { state: 'active' | 'absent' }
  | { state: 'retired'; retiredAt: number; retirementRevision: string; pendingLifecycle: boolean }
  | { state: 'deleted'; receipt: AgentSessionRecordDeletionReceipt; operationIdMatched?: boolean }
)
const fail = (message: string, code = 'INVALID_CONTROL_REQUEST'): never => { throw new AgentMuxError(message, code) }
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\0\r\n]/u.test(value)
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

export function parseAgentSessionRecordInput(value: unknown, deleting = false): AgentSessionRecordInput | AgentSessionRecordDeleteInput {
  const input = { ...rpcRecord(value, deleting ? ['hostId', 'agentSessionId', 'operationId', 'expectedRetiredAt', 'expectedRetirementRevision', 'continue'] : ['hostId', 'agentSessionId', 'operationId']) }
  if (!id(input.hostId) || !id(input.agentSessionId) || input.agentSessionId === 'self' ||
    input.operationId !== undefined && !id(input.operationId)) fail('Record control requires the exact original Host, Session and operation identity.')
  if (deleting && (!id(input.operationId) || !natural(input.expectedRetiredAt) || !revision(input.expectedRetirementRevision) || input.continue !== undefined && input.continue !== true)) fail('Deletion requires the original retirement observation and revision.')
  return input as AgentSessionRecordInput | AgentSessionRecordDeleteInput
}

export function parseAgentSessionRecordDeletion(value: unknown, code = 'INVALID_AGENT_SESSION_STORE'): AgentSessionRecordDeletion {
  const fact = rpcRecord(value, ['operationId', 'retirementRevision', 'deletedAt', 'phase'], code)
  if (!id(fact.operationId) || !revision(fact.retirementRevision) || !natural(fact.deletedAt) || (fact.phase !== 'pending' && fact.phase !== 'complete')) fail('The original record deletion fact is invalid.', code)
  return fact as AgentSessionRecordDeletion
}

/** A terminal observation crosses the same strict machine-fact boundary as its receipt. */
export function parseAgentSessionRecordDeletionEvent(value: unknown): AgentSessionRecordDeletionEvent {
  const code = 'CONTROL_PROTOCOL_ERROR', event = rpcRecord(value, ['type', 'agentSessionId', 'retiredAt', 'recordDeletion'], code)
  if (event.type !== 'agent-session-record-deleted' || !id(event.agentSessionId) || event.agentSessionId === 'self' || !natural(event.retiredAt))
    fail('The original record deletion observation is invalid.', code)
  parseAgentSessionRecordDeletion(event.recordDeletion, code)
  return event as AgentSessionRecordDeletionEvent
}

export function deletedAgentSessionRecord(id: string): never {
  return fail(`AgentMux records for Session ${id} were explicitly deleted. Its terminal identity is retained; Provider originals, Runtime and local unsent content have their own owners.`, 'AGENT_SESSION_RECORD_DELETED')
}

export function parseAgentSessionRecordReceipt(value: unknown, expected: Pick<AgentSessionRecordInput, 'hostId' | 'agentSessionId'> & Partial<AgentSessionRecordDeleteInput>): AgentSessionRecordDeletionReceipt {
  const code = 'CONTROL_PROTOCOL_ERROR', receipt = rpcRecord(value, ['hostId', 'agentSessionId', 'retiredAt', 'deletion', 'persistence'], code)
  const fact = parseAgentSessionRecordDeletion(receipt.deletion, code)
  if (receipt.hostId !== expected.hostId || receipt.agentSessionId !== expected.agentSessionId || !natural(receipt.retiredAt) ||
    receipt.persistence !== 'confirmed' || expected.operationId !== undefined && fact.operationId !== expected.operationId ||
    expected.expectedRetiredAt !== undefined && receipt.retiredAt !== expected.expectedRetiredAt ||
    expected.expectedRetirementRevision !== undefined && fact.retirementRevision !== expected.expectedRetirementRevision) fail('The deletion receipt does not confirm the original target and operation.', code)
  return receipt as AgentSessionRecordDeletionReceipt
}

export function parseAgentSessionRecordInspection(value: unknown, expected: AgentSessionRecordInput): AgentSessionRecordInspection {
  const code = 'CONTROL_PROTOCOL_ERROR', page = rpcRecord(value, ['hostId', 'agentSessionId', 'observedAt', 'state', 'retiredAt', 'retirementRevision', 'pendingLifecycle', 'receipt', 'operationIdMatched'], code)
  if (page.hostId !== expected.hostId || page.agentSessionId !== expected.agentSessionId || !natural(page.observedAt)) fail('Record inspection belongs to another original target.', code)
  if (page.state === 'deleted') {
    rpcRecord(page, ['hostId', 'agentSessionId', 'observedAt', 'state', 'receipt', 'operationIdMatched'], code)
    const receipt = parseAgentSessionRecordReceipt(page.receipt, { hostId: expected.hostId, agentSessionId: expected.agentSessionId })
    if (expected.operationId === undefined ? page.operationIdMatched !== undefined : page.operationIdMatched !== (expected.operationId === receipt.deletion.operationId)) fail('Record inspection changed the original operation correlation.', code)
  } else if (page.state === 'retired') {
    rpcRecord(page, ['hostId', 'agentSessionId', 'observedAt', 'state', 'retiredAt', 'retirementRevision', 'pendingLifecycle'], code)
    if (!natural(page.retiredAt) || !revision(page.retirementRevision) || typeof page.pendingLifecycle !== 'boolean') fail('Retirement inspection is incomplete.', code)
  } else if (page.state === 'active' || page.state === 'absent') rpcRecord(page, ['hostId', 'agentSessionId', 'observedAt', 'state'], code)
  else fail('Record inspection must retain its exact lifecycle observation.', code)
  return page as AgentSessionRecordInspection
}
