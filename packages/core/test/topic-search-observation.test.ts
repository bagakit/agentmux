import { describe, expect, it } from 'vitest'
import { parseTopicParams, parseTopicResult, parseTopicSearchRecord, type TopicSearchRecord } from '../src/public-rpc-topics.js'
import { AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../src/agentmux-cli-help.js'

const record: TopicSearchRecord = {
  searchId: '11111111-1111-4111-8111-111111111111', query: '磁盘', topicId: 'view:disk', limit: 32,
  startedAt: 1, finishedAt: 2, durationMs: 1, outcome: 'complete',
  counters: { topicsVisited: 1, candidates: 3, readBytes: 200, chargedBytes: 131272, unconfirmedReads: 1, entryMatches: 0, documentMatches: 0 },
  stopReason: null, issues: [], omittedIssueCount: 0
}
const result = { entries: [], documents: [], unavailable: [], observation: { record, history: 'saved', unavailable: [] } }
describe('Executed search observations remain exact and separate from persistence', () => {
  it('keeps known reads and unknown reservations distinct without calling healthy search partial', () => {
    expect(parseTopicResult('topic.knowledge.search', result, { topicId: record.topicId!, query: record.query })).toEqual(result)
    const unavailable = { code: 'TOPIC_SEARCH_HISTORY_UNAVAILABLE', message: 'Local history could not be saved.', recovery: 'Retry this search.' }
    const failedHistory = { ...result, observation: { record, history: 'unavailable', unavailable: [unavailable] } }
    expect(parseTopicResult('topic.knowledge.search', failedHistory, { topicId: record.topicId!, query: record.query })).toEqual(failedHistory)
  })
  it.each([
    { query: 'other' }, { topicId: null }, { limit: 33 }, { outcome: 'partial' },
    { counters: { ...record.counters, documentMatches: 1 } }, { searchId: 'latest' },
    { counters: { ...record.counters, readBytes: 131273 } }, { counters: { ...record.counters, unconfirmedReads: 4 } },
    { counters: { ...record.counters, topicsVisited: 2 } }, { counters: { ...record.counters, candidates: -1 } },
    { counters: { ...record.counters, topicsVisited: 0 } }, { counters: { ...record.counters, unconfirmedReads: 0 } },
    { finishedAt: 0 }, { issues: [{ code: 'SOURCE_UNAVAILABLE' }] }, { stopReason: 'deadline' },
    { outcome: 'cancelled', stopReason: null }, { copiedBody: '# Source document' }
  ])('rejects an observation that contradicts the query, scope or owner facts: %j', patch => {
    expect(() => parseTopicResult('topic.knowledge.search', { ...result, observation: { ...result.observation, record: { ...record, ...patch } } },
      { topicId: record.topicId!, query: record.query })).toThrow()
  })
  it('rejects unbounded or invented issues and unconfirmed persistence claims', () => {
    expect(() => parseTopicSearchRecord({ ...record, outcome: ['complete'] })).toThrow()
    expect(() => parseTopicSearchRecord({ ...record, outcome: 'partial', stopReason: ['deadline'], issues: [{ code: 'TIMEOUT' }] })).toThrow()
    for (const issues of [Array.from({ length: 33 }, () => ({ code: 'FAIL' })), [{ code: 'FAIL', message: 'source body' }]])
      expect(() => parseTopicSearchRecord({ ...record, outcome: 'partial', issues })).toThrow()
    for (const observation of [{ ...result.observation, history: 'saved', unavailable: [{ code: 'FAIL', message: 'Failure', recovery: 'Retry' }] },
      { ...result.observation, history: 'unavailable' }, { ...result.observation, history: 'pending' }])
      expect(() => parseTopicResult('topic.knowledge.search', { ...result, observation }, { topicId: record.topicId!, query: record.query })).toThrow()
  })
  it('accepts filtered retained history and rejects records from another original request', () => {
    const history = { records: [record], hasMore: false, retention: { maxRecords: 128, maxBytes: 1048576, prunedRecords: 2 }, unavailable: [] }
    expect(parseTopicResult('topic.knowledge.history', history, {})).toEqual(history)
    expect(parseTopicResult('topic.knowledge.history', history, { topicId: record.topicId!, query: record.query, searchId: record.searchId })).toEqual(history)
    for (const query of [{ topicId: 'view:other' }, { query: '磁' }, { searchId: '22222222-2222-4222-8222-222222222222' }])
      expect(() => parseTopicResult('topic.knowledge.history', history, query)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.history', { ...history, records: [record, record] }, {})).toThrow()
    expect(() => parseTopicResult('topic.knowledge.history', { ...history, retention: { ...history.retention, prunedRecords: -1 } }, {})).toThrow()
  })
  it('discovers the original read-only history method without running another search', () => {
    expect(parseTopicParams('topic.knowledge.history', {})).toEqual({})
    expect(parseTopicParams('topic.knowledge.history', { query: '磁盘', topicId: 'view:disk', searchId: record.searchId })).toEqual({ query: '磁盘', topicId: 'view:disk', searchId: record.searchId })
    for (const p of [{ topicId: 'self' }, { searchId: 'last' }, { query: '' }, { query: '  ' }, { limit: 0 }, { source: 'client' }])
      expect(() => parseTopicParams('topic.knowledge.history', p)).toThrow()
    expect(agentMuxCommandHelp('topic.knowledge.history')).toContain('--search UUID')
    expect(agentMuxCommandHelp('topic.knowledge.history')).toContain('No search or Agent execution')
    expect(AGENTMUX_CLI_SKILL).toContain('amux topic knowledge history')
  })
})
