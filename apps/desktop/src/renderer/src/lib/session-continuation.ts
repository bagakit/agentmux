import type { AgentSessionHistoryPage, AgentSessionHistoryItem } from '@agentmux/core'
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

/** Continue from the selected native record in this exact already read source page. */
export function buildNativeContinuationPrompt(page: AgentSessionHistoryPage, cutoff: AgentSessionHistoryItem): string {
  const index = page.items.indexOf(cutoff)
  if (index < 0) throw new Error('Continuation record is unavailable')
  const seen = new Set<string>()
  const prefix = page.items.slice(0, index + 1).filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  const transcript = prefix.map((item) => {
    const label = item.kind === 'user-message' ? 'Input' : item.kind === 'assistant-message' ? 'Agent' : 'Activity'
    const text = item.contentParts.map((part) => {
      if (part.kind === 'text') return part.text
      if (part.kind === 'reasoning') return part.redacted ? '[Reasoning redacted]' : part.text
      if (part.kind === 'tool-call') return `${part.name}\n${part.input}`
      if (part.kind === 'tool-result') return `${part.name ?? 'Tool result'}\n${part.output}`
      return part.label === undefined ? part.reference : `${part.label}\n${part.reference}`
    }).filter((text) => text.length > 0).join('\n')
    return `${label}: ${text}`
  }).join('\n\n')
  return `Continue this conversation from the selected point.\n\n${transcript}`
}
