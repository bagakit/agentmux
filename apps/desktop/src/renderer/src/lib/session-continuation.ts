import type { ConversationAxisItem } from './conversation-axis'
import { speakerOf } from './conversation-speaker'

/** Build an explicit continuation prompt from a bounded transcript prefix. This creates a fresh Agent
 * session; it never claims provider-native fork semantics. The cutoff is inclusive and later turns are
 * intentionally excluded so a user can continue from a selected point without leaking future context.
 * The selected record comes from this same ordered stream; raw IDs from different sources can collide. */
export function buildContinuationPrompt(messages: readonly ConversationAxisItem[], cutoffMessage: ConversationAxisItem): string {
  const index = messages.indexOf(cutoffMessage)
  if (index < 0) throw new Error('Continuation message is unavailable')
  const prefix = messages.slice(0, index + 1)
  const transcript = prefix.map((message) => {
    const speaker = speakerOf(message)
    const label = speaker?.role === 'human' ? 'User' : speaker?.role === 'agent' ? 'Agent' : speaker?.role === 'unknown' ? 'Input' : 'Activity'
    return `${label}: ${message.content ?? ''}`
  }).join('\n\n')
  return `Continue this conversation from the selected point.\n\n${transcript}`
}
