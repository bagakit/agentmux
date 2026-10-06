import type { AgentSessionUserMessageSource } from '@agentmux/core'
import type { AgentConversationRecordSource } from '@agentmux/core/conversation'

/** A rendered record's identity, never its text, author, timestamp or unscoped raw id. */
export function conversationMessageSourceKey(sessionId: string | undefined, source: AgentSessionUserMessageSource | AgentConversationRecordSource | undefined): string | undefined {
  if (!sessionId || !source) return undefined
  if (source.kind === 'captured') {
    const recordId = 'recordId' in source ? source.recordId : source.submissionId
    return recordId ? JSON.stringify([sessionId, 'captured', recordId]) : undefined
  }
  return source.providerId && source.nativeSessionId && source.recordId
    ? JSON.stringify([sessionId, 'native', source.providerId, source.nativeSessionId, source.recordId]) : undefined
}
