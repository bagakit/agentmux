import type { AgentTimelineItem } from '@agentmux/core'
import { ConversationMessage, type ConversationMessageProps } from './ConversationMessage.js'
import { conversationItemRef } from '@agentmux/core/conversation'
/** Exact captured record metadata. A failed native reader cannot hide a confirmed Hook reply. */
export function CapturedConversationMessage({ item, ...props }: Omit<ConversationMessageProps, 'content' | 'messageId' | 'createdAt' | 'status'> & { item: AgentTimelineItem }) {
  const itemRef = conversationItemRef({ agentSessionId: item.agentSessionId, ...(props.executionHostId ? { executionHostId: props.executionHostId } : {}), source: { kind: 'captured', recordId: item.id } })
  return <ConversationMessage {...props} {...(itemRef ? { itemRef } : {})} messageId={item.id} content={item.content ?? ''} status={item.status} createdAt={item.createdAt} />
}
