import { consumeConversationWindowPage, conversationValuesEqual, CONVERSATION_MAX_READ_BYTES, type ConversationVersionedAnchor, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import type { ConversationViewClient } from './use-conversation-view.js'

export type ConversationProcessDetailReader = (anchor: ConversationVersionedAnchor, signal: AbortSignal) => Promise<ConversationWindowSnapshot>

/** One exact original read through the existing Reader. Its temporary view is
 * released after transport assembly; the mounted disclosure owns the returned body. */
export async function readConversationProcessDetail(client: ConversationViewClient, anchor: ConversationVersionedAnchor, signal: AbortSignal): Promise<ConversationWindowSnapshot> {
  const reference = { hostId: anchor.frontier.hostId, agentSessionId: anchor.frontier.agentSessionId }
  let pending: ConversationWindowAssembly | undefined, cursor: string | undefined, release: string | undefined
  try {
    do {
      signal.throwIfAborted()
      const page = await client.readAgentConversation({ ...reference, anchor, limit: 100, maxBytes: CONVERSATION_MAX_READ_BYTES, ...(cursor ? { cursor } : {}) }, { signal })
      release = page.window.view ?? page.window.replay
      signal.throwIfAborted()
      const consumed = consumeConversationWindowPage(page, pending)
      if (consumed.kind === 'complete') {
        const records = consumed.snapshot.units.flatMap(unit => unit.records)
        if (records.length !== 1 || records[0]!.original.kind === 'deferred' || records[0]!.revision !== anchor.revision || !conversationValuesEqual(records[0]!.reference, anchor.record)) {
          const source = anchor.record.source
          const failed = consumed.snapshot.coverage.find(row => row.source.kind === source.kind && (source.kind === 'captured' || row.source.kind === 'native' && row.source.providerId === source.providerId && row.source.nativeSessionId === source.nativeSessionId))
          throw new Error(failed?.gaps.map(gap => gap.message).join(' ') || 'The exact original process version is unavailable. Retry this original record.')
        }
        return consumed.snapshot
      }
      pending = consumed.pending
      if (!page.nextCursor || page.nextCursor === cursor) throw new Error('The original process detail did not finish. Retry this exact record.')
      cursor = page.nextCursor
    } while (true)
  } finally { if (release) await client.releaseConversationView({ ...reference, view: release }).catch(() => {}) }
}
