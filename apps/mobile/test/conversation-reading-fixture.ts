import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { conversationRevision, projectConversationTimeline, type AgentConversationReadPage } from '@agentmux/core/conversation'
import type { fixture } from './conversation-fixture'

/** Controlled public Reader port over the fixture's original source records. */
export function installConversationReading(f: ReturnType<typeof fixture>) {
  const versions = new Map<string, { digest: string; revision: number }>()
  const frames = new Map<string, AgentConversationReadPage>()
  const cursors = new Map<string, string | undefined>()
  const read: AgentMuxHostedClient['readAgentConversation'] = async input => {
    const sourceHostId = f.sessions.get(input.agentSessionId)!.hostId
    const cursor = input.cursor === 'fixture-latest' ? undefined : input.cursor ?? (input.view ? cursors.get(input.agentSessionId) : undefined)
    const [historyPage, captured] = await Promise.all([f.readHistory(input.agentSessionId, cursor ? { cursor } : undefined), f.readTimeline(input.agentSessionId)])
    if (historyPage.agentSessionId !== input.agentSessionId) throw new Error('History page belongs to another Session')
    if (captured.agentSessionId !== input.agentSessionId) throw new Error('Timeline belongs to another Session')
    const digest = conversationRevision({ historyPage, captured }), previous = versions.get(input.agentSessionId)
    const revision = previous?.digest === digest ? previous.revision : (previous?.revision ?? 0) + 1
    versions.set(input.agentSessionId, { digest, revision })
    const timeline = projectConversationTimeline({ agentSessionId: input.agentSessionId, executionHostId: sourceHostId,
      historyPage: { ...historyPage, sourceHostId }, timeline: { ...captured, sourceHostId,
        stream: { epoch: 'original-mobile-stream', sequence: captured.items.length, revision, origin: 'beginning', gaps: [],
          positions: captured.items.map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: conversationRevision(item) })) } } })
    const reference = { hostId: input.hostId, agentSessionId: input.agentSessionId }
    const checkpoint = { ...reference, sourceHostId, frontier: { ...reference, scope: timeline.scope, cuts: [] } }
    const frame = { ...reference, sourceHostId, scope: timeline.scope, coverage: timeline.coverage,
      order: { ...timeline.order, direction: 'newest-first' }, budgetBytes: input.maxBytes ?? 128 * 1024, nextCursor: null,
      items: [...timeline.events].reverse().map(event => ({ kind: 'item', item: { event,
        records: timeline.records.filter(record => event.recordIds.includes(record.id)) } })),
      window: { id: 'original-mobile-window', revision, itemCount: timeline.events.length, complete: true,
        view: 'original-mobile-view', replay: 'original-mobile-replay-' + revision, checkpoint,
        outside: { older: null, newer: null }, navigation: { older: historyPage.nextCursor, newer: cursor ? 'fixture-latest' : null } } } satisfies AgentConversationReadPage
    frames.set(input.agentSessionId, frame); cursors.set(input.agentSessionId, cursor)
    return frame
  }
  Object.assign(f.client, {
    readAgentConversation: read,
    readConversationChanges: async (input: Parameters<AgentMuxHostedClient['readConversationChanges']>[0]) => ({ ...await read(input), checkpoint: input.checkpoint, more: false }),
    observeConversation: async (input: Parameters<AgentMuxHostedClient['observeConversation']>[0], listener: Parameters<AgentMuxHostedClient['observeConversation']>[1]) => {
      const frame = frames.get(input.agentSessionId), reference = { hostId: input.hostId, agentSessionId: input.agentSessionId }, sourceHostId = f.sessions.get(input.agentSessionId)!.hostId
      const scope = frame?.scope ?? { sources: [] }, coverage = frame?.coverage ?? []
      const invalidate = () => {
        const source = scope.sources.find(value => value.kind === 'native') ?? scope.sources[0]
        if (source) listener({ ...reference, sourceHostId, source, kind: 'invalidated' })
      }
      const handle = input.view ? await f.client.observeSessionHistory(input.agentSessionId, invalidate, {}) : null
      const unlisten = input.view ? f.client.onEvent(event => {
        if (event.type === 'agent-timeline' && event.agentSessionId === input.agentSessionId || event.type === 'agent-session' && event.session.agentSessionId === input.agentSessionId) invalidate()
      }) : undefined
      return { ...reference, sourceHostId, scope, coverage, closed: new AbortController().signal, dispose() { handle?.dispose(); unlisten?.() } }
    },
    releaseConversationView: async () => ({})
  })
}
