import { AgentMuxError } from './errors.js'
import { parseConversationLandmarkRef } from './conversation-landmarks.js'
import type { ConversationItemRef, ConversationRef } from './conversation.js'

/** Select an existing client consumer. Inspection never opens a conversation. */
export type ConversationConsumerQuery = ConversationRef & {
  expectedRunId?: string
  consumerId?: string
  records?: readonly ConversationItemRef[]
}

export function parseConversationConsumerQuery(value: unknown): ConversationConsumerQuery {
  const invalid = (): never => { throw new AgentMuxError('Conversation consumer inspection requires exact identities and original record references.', 'INVALID_CONTROL_REQUEST') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['hostId', 'agentSessionId', 'expectedRunId', 'consumerId', 'records'].includes(key))) return invalid()
  const identity = (value: unknown): string => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : invalid()
  let records: ConversationItemRef[] | undefined
  if (input.records !== undefined) {
    if (!Array.isArray(input.records)) return invalid()
    try { records = input.records.map(parseConversationLandmarkRef) } catch { return invalid() }
  }
  return { hostId: identity(input.hostId), agentSessionId: identity(input.agentSessionId),
    ...(input.expectedRunId === undefined ? {} : { expectedRunId: identity(input.expectedRunId) }),
    ...(input.consumerId === undefined ? {} : { consumerId: identity(input.consumerId) }),
    ...(records === undefined ? {} : { records }) }
}
