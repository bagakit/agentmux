import { projectConversationTimeline, type ConversationCheckpoint, type ConversationChangesPage, type NativeConversationCheckpoint } from '@agentmux/core/conversation'
import type { AgentSessionHistoryItem } from '@agentmux/core'
import type { PublicationBoundary } from '../../src/publication-store.js'

/** Real Core pure projector supplies all identities, roles, authors and relations to lower outbox fixtures. */
export function publicationPage(boundary: PublicationBoundary, native: NativeConversationCheckpoint, items: AgentSessionHistoryItem[], sourceHostId = boundary.executionHostId) {
  const timeline = projectConversationTimeline({ agentSessionId: boundary.agentSessionId, executionHostId: sourceHostId,
    historyPage: { agentSessionId: boundary.agentSessionId, source: native.source, items, nextCursor: null } })
  const checkpoint: ConversationCheckpoint = { hostId: boundary.executionHostId, agentSessionId: boundary.agentSessionId, sourceHostId,
    frontier: { hostId: sourceHostId, agentSessionId: boundary.agentSessionId, scope: timeline.scope, cuts: [{ kind: 'native', checkpoint: native }] } }
  const units = timeline.events.map(event => ({ event, records: timeline.records.filter(record => event.recordIds.includes(record.id)) }))
  const page: ConversationChangesPage = { hostId: boundary.executionHostId, agentSessionId: boundary.agentSessionId, sourceHostId, scope: timeline.scope,
    coverage: timeline.coverage, order: { ...timeline.order, direction: 'newest-first' }, items: [...units].reverse().map(item => ({ kind: 'item', item })),
    nextCursor: null, budgetBytes: 4 * 1024 * 1024, checkpoint, more: false }
  return { page, units, resolvedText: new Map() }
}
