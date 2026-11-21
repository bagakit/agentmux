import { CONVERSATION_MAX_READ_BYTES, consumeConversationWindowPage, conversationRecordId, type ConversationWindowAssembly } from '@agentmux/core/conversation'
import type { RecallCard } from '@agentmux/core/notebook-observation'
import { api } from './api'

/** Capture only the selected record's visible text slots. Other material remains at its source. */
export async function readRecallSource(card: RecallCard): Promise<{ text: string; partial: boolean } | null> {
  const scope = { hostId: card.routeHostId, agentSessionId: card.reference.agentSessionId }
  const request = { ...scope, record: card.reference, limit: 100, maxBytes: CONVERSATION_MAX_READ_BYTES }
  const id = conversationRecordId(card.reference)
  let pending: ConversationWindowAssembly | undefined, cursor: string | undefined, view: string | undefined
  try {
    for (;;) {
      const page = await api.conversation.readAgentConversation({ ...request, ...(cursor ? { cursor } : {}) })
      view = page.window.view ?? page.window.replay
      const result = consumeConversationWindowPage(page, pending)
      if (result.kind === 'pending') {
        if (!page.nextCursor || page.nextCursor === cursor) return null
        cursor = page.nextCursor
        pending = result.pending
        continue
      }

      const unit = result.snapshot.units.find(candidate => candidate.records.some(record => record.id === id))
      const source = unit?.records.find(record => record.id === id)?.original
      if (unit?.event.role !== 'message' || !source || source.kind === 'deferred') return null
      const slots = unit.event.content.filter(slot => slot.recordId === id && slot.placement === 'body')
      const parts = slots.flatMap(({ selector }) => {
        if (source.kind === 'native' && selector.kind === 'native-part') {
          const part = source.item.contentParts[selector.partIndex]
          return part?.kind === 'text' && !part.contentRole ? [part.text] : []
        }
        if (source.kind === 'captured' && selector.kind === 'captured-field' && selector.field === 'content' &&
          typeof source.item.content === 'string') return [source.item.content]
        return []
      })
      const text = parts.join('\n\n')
      return text.trim() ? { text, partial: parts.length !== slots.length } : null
    }
  } catch {
    // The caller presents a link-only result and keeps the exact source reference.
    return null
  } finally {
    if (view) await api.conversation.releaseConversationView({ ...scope, view }).catch(() => {})
  }
}
