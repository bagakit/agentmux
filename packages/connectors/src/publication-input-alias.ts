import { conversationNativeInputWitness, conversationRecordId, isCompleteConversationRecord, type ConversationInputWitness, type ConversationUnit } from '@agentmux/core/conversation'
import type { ConnectionDeliveryGap } from '@agentmux/core/connections'

/** Only an accepted native user text wrapper can have an alternative public representation. */
export function publicationInputAlias(unit: ConversationUnit, gap: ConnectionDeliveryGap): ConversationInputWitness | undefined {
  const part = gap.part
  if (gap.reason !== 'public-content-unconfirmed' || !part || part.selector.kind !== 'native-part') return
  const record = unit.records.filter(isCompleteConversationRecord).find(record => record.reference && record.revision === part.recordRevision && conversationRecordId(record.reference) === conversationRecordId(part.record))
  if (!record || record.original.kind !== 'native' || record.original.item.kind !== 'user-message') return
  const value = record.original.item.contentParts[part.selector.partIndex]
  if (value?.kind !== 'text' || value.contentRole === 'tool' || value.contentRole === 'reasoning') return
  const witness = conversationNativeInputWitness(record)
  return witness?.key ? witness : undefined
}
