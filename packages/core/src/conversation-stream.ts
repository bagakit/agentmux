import type { AgentTimelineItem } from './types.js'
import type * as Semantics from '@agentmux/conversation/semantics'

export * from '@agentmux/conversation/semantics'

export type ConversationSourceRecord = Semantics.ConversationSourceRecord<AgentTimelineItem>
export type ConversationStreamInput = Semantics.ConversationStreamInput<ConversationSourceRecord>
export type ConversationTimeline = Semantics.ConversationTimeline<ConversationSourceRecord>
