import type { AgentSessionUserMessageAuthor, AgentTimelineItem } from './types.js'

/** Recorded attribution only. Neither a credential nor a content-sharing boundary. */
export function recordedConversationAuthor(item: Pick<AgentTimelineItem, 'authorAgentSessionId' | 'authorExternal' | 'authorHuman'>): AgentSessionUserMessageAuthor {
  if (item.authorAgentSessionId !== undefined) return { kind: 'agent', agentSessionId: item.authorAgentSessionId }
  if (item.authorExternal !== undefined) return item.authorExternal
  if (item.authorHuman === true) return { kind: 'human' }
  return { kind: 'unknown' }
}
