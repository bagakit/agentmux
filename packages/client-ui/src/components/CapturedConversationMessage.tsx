import type { AgentTimelineItem } from '@agentmux/core'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage.js'
/** Exact captured record metadata. A failed native reader cannot hide a confirmed Hook reply. */
export function CapturedConversationMessage({ item, ...props }: Omit<ConversationMessageProps, 'content' | 'messageId' | 'createdAt' | 'status'> & { item: AgentTimelineItem }) {
  return <ConversationMessage {...props} messageId={item.id} content={item.content ?? ''} status={item.status} createdAt={item.createdAt} />
}
