import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { conversationRevision, projectConversationRecords, projectConversationSummary, projectConversationTimeline,
  type AgentConversationRecord, type ConversationProjectionInput } from '../src/conversation.js'
import type { AgentSessionHistoryPage, AgentTimelineItem, AgentTimelineSnapshot } from '../src/types.js'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('@noble/hashes/sha2.js', async original => {
  const actual = await original<typeof import('@noble/hashes/sha2.js')>()
  return { ...actual, sha256: vi.fn(actual.sha256) }
})

const digest = vi.mocked(sha256)
afterEach(() => digest.mockClear())
const sid = 'summary-original', hostId = 'original-host'
const source = { providerId: 'claude', nativeSessionId: 'original-native' }
const ref = (recordId: string) => ({ hostId, agentSessionId: sid, source: { kind: 'native' as const, ...source, recordId } })
const captured = (id: string, fields: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({
  id, agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original reply',
  content: `Complete original content ${id}`, createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1), ...fields
})
function snapshot(items: AgentTimelineItem[], positions = true): AgentTimelineSnapshot {
  return { agentSessionId: sid, sourceHostId: hostId, revision: items.length, items,
    ...(positions ? { stream: { epoch: 'original-epoch', sequence: items.length, revision: items.length, origin: 'beginning' as const, gaps: [],
      positions: items.map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: conversationRevision(item) })) } } : {}) }
}
const page = (items: AgentSessionHistoryPage['items']): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: hostId, source, items, nextCursor: null })
function summaryFields({ event: _event, records: _records, input: _input, ...facts }: AgentConversationRecord) { return facts }
function compare(input: ConversationProjectionInput) {
  const original = structuredClone(input)
  const full = projectConversationRecords(input), summary = projectConversationSummary(input)
  expect(summary.length).toBeGreaterThan(0)
  expect(summary).toEqual(full.map(summaryFields))
  for (const value of summary) {
    expect(value).not.toHaveProperty('event'); expect(value).not.toHaveProperty('records'); expect(value).not.toHaveProperty('input')
    const original = value.original
    expect(original.kind === 'captured' ? input.timeline?.items.includes(original.item) : input.historyPage?.items.includes(original.item)).toBe(true)
  }
  expect(input).toEqual(original)
  return summary
}

it('preserves full captured observations, explicit authors, process-only facts and original object identity', () => {
  const body = 'Original complete Unicode response 你好. '.repeat(1200)
  const items = [captured('prompt', { kind: 'user_message', source: 'user', authorHuman: true, content: 'Original human input' }),
    captured('observation', { content: body }), captured('tool', { kind: 'tool_call', toolInput: '{}', toolOutput: 'Original output' }),
    captured('external-agent', { authorAgentSessionId: 'another-agent' })]
  for (const positions of [true, false]) {
    const summary = compare({ agentSessionId: sid, timeline: snapshot(items, positions) })
    expect(summary.map(value => value.role)).toEqual(['message', 'observation', 'process', 'message'])
    expect(summary[1]!.content).toBe(body)
    expect(summary[1]!.original.item).toBe(items[1])
    expect(summary[3]!.author).toEqual({ kind: 'agent', agentSessionId: 'another-agent' })
  }
})

it('reuses native reading ranges and question answers while preserving mixed native parts', () => {
  const input = { agentSessionId: sid, historyPage: page([
    { id: 'original-question-answer', kind: 'user-message' as const, startedAt: fixtureEpoch(0, 0, 20),
      contentParts: [{ kind: 'text' as const, text: 'Original question wrapper' },
        { kind: 'text' as const, text: 'wrapper: Original reading', readingRange: { start: 9, end: 25 } }],
      questionAnswers: [{ questionId: 'original-question', answer: 'Original chosen answer' }] },
    { id: 'original-mixed-reply', kind: 'assistant-message' as const, startedAt: fixtureEpoch(0, 0, 10),
      contentParts: [{ kind: 'text' as const, text: 'Original speech' }, { kind: 'tool-call' as const, name: 'Read', input: '{}', callId: 'original-call' }, { kind: 'text' as const, text: 'Speech after tools' }] }
  ]) }
  const summary = compare(input)
  expect(summary.map(value => value.rawId)).toEqual(['original-question-answer', 'original-mixed-reply'])
  expect(summary[0]!.content).toBe('Original chosen answer\nOriginal reading')
  expect(summary[1]!.contentParts).toBe(input.historyPage.items[1]!.contentParts)
  expect(summary[1]!.author).toEqual({ kind: 'agent', agentSessionId: sid })
})

it('keeps canonical association, unread anchors and conflicting authors in the same semantic graph', () => {
  const native = page([{ id: 'canonical', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Canonical original speech' }] }])
  const items = [captured('first-observer', { authorHuman: true, conversation: { sameEvent: ref('canonical') } }),
    captured('second-observer', { authorAgentSessionId: 'another-agent', conversation: { sameEvent: ref('canonical') } }),
    captured('unread-observer', { conversation: { sameEvent: ref('unread-canonical') }, content: 'Unread-anchor original contribution' })]
  const summary = compare({ agentSessionId: sid, historyPage: native, timeline: snapshot(items) })
  expect(summary).toHaveLength(2)
  expect(summary[0]!.content).toBe('Canonical original speech'); expect(summary[0]!.author).toEqual({ kind: 'unknown' })
  expect(summary[1]!.content).toBe('Unread-anchor original contribution')
  expect(summary[1]!.rawId).toBe('unread-observer')
  expect(items.map(item => item.content)).toEqual(['Complete original content first-observer', 'Complete original content second-observer', 'Unread-anchor original contribution'])
  const foreign = compare({ agentSessionId: sid, historyPage: { ...native, sourceHostId: 'another-host' }, timeline: snapshot(items) })
  expect(foreign).toHaveLength(3)
})

it('retains independent originals on relation cycles and never infers association from equal text', () => {
  const native = page([{ id: 'first', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Equal original body' }], conversation: { sameEvent: ref('second') } },
    { id: 'second', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Equal original body' }], conversation: { sameEvent: ref('first') } }])
  const summary = compare({ agentSessionId: sid, historyPage: native, timeline: snapshot([captured('independent', { content: 'Equal original body' })]) })
  expect(summary).toHaveLength(3); expect(new Set(summary.map(value => value.id)).size).toBe(3)
})

it('does no event hashing for nonempty captured summaries at both input sizes and retains required native record hashing', () => {
  for (const count of [14, 112]) {
    const timeline = snapshot(Array.from({ length: 40 }, (_, index) => captured(`reply-${index}`)))
    digest.mockClear()
    for (let index = 0; index < count; index++) expect(projectConversationSummary({ agentSessionId: sid, timeline })).toHaveLength(40)
    expect(digest.mock.calls.length).toBe(0)
    const full = projectConversationTimeline({ agentSessionId: sid, timeline })
    expect(full.events).toHaveLength(40); expect(digest).toHaveBeenCalledTimes(40)
  }
  const native = page([{ id: 'native-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original native content' }] }])
  digest.mockClear(); expect(projectConversationSummary({ agentSessionId: sid, historyPage: native })).toHaveLength(1)
  expect(digest).toHaveBeenCalledTimes(1)
  digest.mockClear(); projectConversationRecords({ agentSessionId: sid, historyPage: native })
  expect(digest).toHaveBeenCalledTimes(2)
})

it('keeps the full public event hash byte-for-byte accurate after summary materialization', () => {
  const timeline = snapshot([captured('versioned-original')])
  const before = projectConversationTimeline({ agentSessionId: sid, timeline })
  projectConversationSummary({ agentSessionId: sid, timeline })
  const full = projectConversationTimeline({ agentSessionId: sid, timeline })
  expect(full).toEqual(before)
  const { revision, ...event } = full.events[0]!
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)])) : value
  const expected = createHash('sha256').update(JSON.stringify(canonical({ policy: 1, versions: full.records.map(record => [record.id, record.revision]), event }))).digest('hex')
  expect(revision).toBe(expected)
})
