import type { ConversationRecord } from './conversation-records.js'
import { conversationA2ANotificationId } from '@agentmux/core/conversation'

export const CONVERSATION_DETAIL_LEVELS = ['simple', 'snapshots', 'collaboration', 'system'] as const
export type ConversationDetailLevel = typeof CONVERSATION_DETAIL_LEVELS[number]
export const CONVERSATION_DETAIL_LEVEL_DEFAULT: ConversationDetailLevel = 'simple'
export const CONVERSATION_DETAIL_LABELS: Record<ConversationDetailLevel, { title: string; description: string }> = {
  simple: { title: '简洁', description: '对话与本轮用量，工具过程按需展开' },
  snapshots: { title: '回复快照', description: '增加事件回报附带的回复快照' },
  collaboration: { title: '协作', description: '再显示 Subagent 回报' },
  system: { title: '全部详情', description: '再显示系统事件原记录' }
}
export function isConversationDetailLevel(value: unknown): value is ConversationDetailLevel {
  return CONVERSATION_DETAIL_LEVELS.some(level => level === value)
}
/** Unsupported saved choices retain complete reading instead of silently hiding content. */
export function resolveConversationDetailLevel(value: unknown): ConversationDetailLevel {
  return value === undefined ? CONVERSATION_DETAIL_LEVEL_DEFAULT : isConversationDetailLevel(value) ? value : 'system'
}

/** Only recorded types determine the additional reading tier, never titles or prose. */
export function conversationRecordDetailLevel(record: ConversationRecord): ConversationDetailLevel {
  const original = record.original.kind === 'deferred' ? record.original.item : record.original
  const item = original.item
  const native = original.kind === 'native' ? original : undefined
  const parts = native ? 'parts' in native ? native.parts : native.item.contentParts : undefined
  const collaboration = native ? 'parts' in native ? native.collaboration : native.item.collaboration : undefined
  if (record.role === 'interaction' || conversationA2ANotificationId(record) || record.role === 'message' && collaboration?.kind !== 'message'
    || item.turnOutcome?.status === 'failed' || item.turnOutcome?.status === 'interrupted' || native?.item.metricsDiagnostic || native?.item.turnOutcomeDiagnostic
    || record.sources?.main.unread || record.sources?.parts.some(part => part.unread)
    || original.kind === 'captured' && (original.item.status === 'failed' || original.item.kind === 'permission')
    || parts?.some(part => part.kind === 'tool-result' && part.failed)
    || collaboration?.kind === 'operation' && collaboration.status === 'failed') return 'simple'
  if (record.role === 'observation') return record.sources?.replyTargetReadable ? 'snapshots' : 'simple'
  if (collaboration?.kind === 'message') return 'collaboration'
  if (native?.item.conversation?.adoptedInput?.purpose === 'a2a-notification') return 'simple'
  if (native?.item.recordPurpose === 'system-event' || native?.item.kind === 'system-message'
    || collaboration?.kind === 'agent-activity'
    || original.kind === 'captured' && (original.item.kind === 'system_message' || original.item.kind === 'lifecycle')) return 'system'
  return 'simple'
}
export function conversationRecordVisibleAtLevel(record: ConversationRecord, level: ConversationDetailLevel): boolean {
  return CONVERSATION_DETAIL_LEVELS.indexOf(conversationRecordDetailLevel(record)) <= CONVERSATION_DETAIL_LEVELS.indexOf(level)
}
