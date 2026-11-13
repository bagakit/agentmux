import { isCompleteConversationRecord, conversationRecordId, type ConversationUnit, type ConversationCheckpoint, type ConversationReadRecord } from '@agentmux/core/conversation'
import type { ConnectionSourceReview, RoomBinding } from '@agentmux/core/connections'
import { isConversationPublicationPart, publicationContent } from './publication-content.js'
/** Review and delivery borrow the same original typed publication eligibility. */
export function sourceReviewItems(units: readonly ConversationUnit[], binding: Pick<RoomBinding, 'bindingId' | 'connectionId' | 'externalConversationId' | 'scope' | 'sourceFrontier'>, frontier: ConversationCheckpoint, includeBodies = true): { items: ConnectionSourceReview['items']; excluded: number } {
  const items: ConnectionSourceReview['items'] = []; let excluded = 0
  for (const unit of [...units].reverse()) {
    let plan: ReturnType<typeof publicationContent> | undefined
    const content = () => plan ??= publicationContent(unit, binding, frontier, { resolved: new Map(), origin: () => undefined })
    for (const record of unit.records) {
      if (!isCompleteConversationRecord(record) || record.original.kind !== 'native' || !record.reference) continue
      const parts = record.original.item.contentParts.flatMap((part, partIndex) => part.contentEligibility === 'public' && isConversationPublicationPart(record, { kind: 'native-part', partIndex }, unit.event.author) ? [{ part, partIndex }] : [])
      const failed = record.original.item.turnOutcome?.status === 'failed' ? content().failure : undefined
      if (!parts.length && !failed) { excluded++; continue }
      const key = conversationRecordId(record.reference)
      const text = includeBodies ? content().pieces.filter(piece => conversationRecordId(piece.part.record) === key).map(piece => piece.text).filter(Boolean).join('\n\n') : ''
      items.push({ disposition: 'unconfirmed', anchor: { record: record.reference, revision: record.revision, frontier }, text: failed ? [failed.code, failed.message, failed.recovery].filter(Boolean).join('\n') : text,
        resources: includeBodies ? parts.flatMap(({ part, partIndex }) => part.kind === 'resource' ? [{ partIndex, reference: part.reference }] : []) : [] })
    }
  }
  return { items, excluded }
}
export function recoveryRecordClosed(record: ConversationReadRecord, unit: ConversationUnit): boolean {
  if (!isCompleteConversationRecord(record)) return false
  const original = record.original, provenance = original.item.conversation, target = provenance?.sameEvent
  return (!provenance || Object.keys(provenance).every(key => key === 'nativeInvocationScope' || key === 'sameEvent')) &&
    (original.kind !== 'native' || !original.item.questionRequest && !original.item.questionAnswers) &&
    (!target || unit.records.some(member => member.reference && conversationRecordId(member.reference) === conversationRecordId(target)))
}
