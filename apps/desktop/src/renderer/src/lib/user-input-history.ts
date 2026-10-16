import type { AgentSessionUserMessage } from '@agentmux/core'
import { conversationRecordId, type ConversationInputEntity, type ConversationWindowBoundary } from '@agentmux/core/conversation'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'

const versionKey = ({ record, revision }: ConversationWindowBoundary) => JSON.stringify([conversationRecordId(record), revision])

/** This face excludes exact versions already owned by accepted Agent input entities.
 * Original query records, unknown authors, bodies and cursor coverage stay untouched.
 * Membership belongs to the current Core view, never text, a claim or a retained cache.
 */
export function userInputHistoryMessages(messages: readonly AgentSessionUserMessage[], inputs: readonly ConversationInputEntity[],
  scope: { hostId: string; agentSessionId: string }): readonly AgentSessionUserMessage[] {
  const agentRecords = new Set<string>()
  for (const input of inputs) {
    if (input.hostId !== scope.hostId || input.agentSessionId !== scope.agentSessionId || !input.sourceHostId || input.event.author.kind !== 'agent') continue
    for (const record of input.records) if (record.reference?.hostId === input.sourceHostId && record.reference.agentSessionId === scope.agentSessionId)
      agentRecords.add(versionKey({ record: record.reference, revision: record.revision }))
  }
  return messages.filter(message => {
    if (message.author.kind === 'agent') return false
    const original = message.sourceRecord
    if (!original || message.agentSessionId !== scope.agentSessionId || original.record.agentSessionId !== scope.agentSessionId ||
      conversationMessageSourceKey(scope.agentSessionId, original.record.source) !== conversationMessageSourceKey(scope.agentSessionId, message.source)) return true
    return !agentRecords.has(versionKey(original))
  })
}
