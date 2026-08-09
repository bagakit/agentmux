import type { AgentTimelineItem } from '../../../shared/contracts'

/** Build an explicit continuation prompt from a bounded transcript prefix. This creates a fresh Agent
 * session; it never claims provider-native fork semantics. The cutoff is inclusive and later turns are
 * intentionally excluded so a user can continue from a selected point without leaking future context. */
export function buildContinuationPrompt(messages: readonly AgentTimelineItem[], cutoffMessageId: string): string {
  const index = messages.findIndex((message) => message.id === cutoffMessageId)
  if (index < 0) throw new Error('Continuation message is unavailable')
  const prefix = messages.slice(0, index + 1)
  const transcript = prefix.map((message) => {
    const speaker = message.source === 'user' || message.kind === 'user_message' ? 'User' : 'Agent'
    return `${speaker}: ${message.content ?? ''}`
  }).join('\n\n')
  return `Continue this conversation from the selected point.\n\n${transcript}`
}
