import type { AgentSessionUserMessageSource } from '@agentmux/core'

/** A rendered record's identity, never its text, author, timestamp or unscoped raw id. */
export function conversationMessageSourceKey(sessionId: string | undefined, source: AgentSessionUserMessageSource | undefined): string | undefined {
  if (!sessionId || !source) return undefined
  if (source.kind === 'captured') return source.submissionId
    ? JSON.stringify([sessionId, 'captured', source.submissionId]) : undefined
  return source.providerId && source.nativeSessionId && source.recordId
    ? JSON.stringify([sessionId, 'native', source.providerId, source.nativeSessionId, source.recordId]) : undefined
}
