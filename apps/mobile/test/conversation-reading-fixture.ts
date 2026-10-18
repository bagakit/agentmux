import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { conversationRevision, projectConversationTimeline, type AgentConversationReadPage } from '@agentmux/core/conversation'
import type { fixture } from './conversation-fixture'

/** Controlled public Reader port over the fixture's original source records. */
export function installConversationReading(f: ReturnType<typeof fixture>) {
  const versions = new Map<string, { digest: string; revision: number }>()
  const read: AgentMuxHostedClient['readAgentConversation'] = async input => {
    const sourceHostId = f.sessions.get(input.agentSessionId)!.hostId
    const [historyPage, captured] = await Promise.all([f.readHistory(input.agentSessionId), f.readTimeline(input.agentSessionId)])
    const digest = conversationRevision({ historyPage, captured }), previous = versions.get(input.agentSessionId)
    const revision = previous?.digest === digest ? previous.revision : (previous?.revision ?? 0) + 1
    versions.set(input.agentSessionId, { digest, revision })
    const timeline = projectConversationTimeline({ agentSessionId: input.agentSessionId, executionHostId: sourceHostId,
      historyPage: { ...historyPage, sourceHostId }, timeline: { ...captured, sourceHostId,
        stream: { epoch: 'original-mobile-stream', sequence: captured.items.length, revision, origin: 'beginning', gaps: [],
          positions: captured.items.map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: conversationRevision(item) })) } } })
    const reference = { hostId: input.hostId, agentSessionId: input.agentSessionId }
    const checkpoint = { ...reference, sourceHostId, frontier: { ...reference, scope: timeline.scope, cuts: [] } }
    return { ...reference, sourceHostId, scope: timeline.scope, coverage: timeline.coverage,
      order: { ...timeline.order, direction: 'newest-first' }, budgetBytes: input.maxBytes ?? 128 * 1024, nextCursor: null,
      items: [...timeline.events].reverse().map(event => ({ kind: 'item', item: { event,
        records: timeline.records.filter(record => event.recordIds.includes(record.id)) } })),
      window: { id: 'original-mobile-window', revision, itemCount: timeline.events.length, complete: true,
        view: 'original-mobile-view', replay: 'original-mobile-replay-' + revision, checkpoint,
        outside: { older: null, newer: null }, navigation: { older: null, newer: null } } } satisfies AgentConversationReadPage
  }
  Object.assign(f.client, {
    readAgentConversation: read,
    readConversationChanges: async (input: Parameters<AgentMuxHostedClient['readConversationChanges']>[0]) => ({ ...await read(input), checkpoint: input.checkpoint, more: false }),
    observeConversation: async (input: Parameters<AgentMuxHostedClient['observeConversation']>[0]) => {
      const frame = await read(input)
      return { hostId: frame.hostId, sourceHostId: frame.sourceHostId, agentSessionId: frame.agentSessionId,
        scope: frame.scope, coverage: frame.coverage, closed: new AbortController().signal, dispose() {} }
    },
    releaseConversationView: async () => ({})
  })
}
