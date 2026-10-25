import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import type { AgentSessionHistoryItem } from '@agentmux/core'
import { PublicationStore, type PublicationBoundary } from '../src/publication-store.js'
import { publicationPage } from './fixtures/publication-page.js'
import { replyMetadata, replyRecord, type ReplyFact, type ReplyProjection } from '../src/publication-reply-metadata.js'
import { projectConversationTimeline } from '@agentmux/core/conversation'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { feishuConfig } from './fixtures/feishu.js'

const closes: Array<() => void> = []
afterEach(() => { for (const close of closes.splice(0)) close() })
const source = { providerId: 'codex', nativeSessionId: 'original-native' }
const usage = (id: string, outputTokens: number): AgentSessionHistoryItem => ({ id, kind: 'activity', turnId: 'same-turn', contentParts: [], metrics: { scope: 'turn', usage: { outputTokens } } })
const answer = (id = 'reply'): AgentSessionHistoryItem => ({ id, kind: 'assistant-message', messagePhase: 'final', turnId: 'same-turn', contentParts: [{ kind: 'text', text: id, contentEligibility: 'public' }] })
function fixture(metadata = true) {
  const database = new DatabaseSync(':memory:'); closes.push(() => database.close())
  const store = new PublicationStore(database), native = { agentSessionId: 'agent', source, cursor: 'start' }
  const boundary: PublicationBoundary = { bindingId: 'binding', revision: 1, connectionId: 'connection', application: feishuConfig.application, executionHostId: 'local', agentSessionId: 'agent', externalConversationId: 'room', sourceCheckpoints: [native], scope: { input: 'all-messages', publication: 'future-shared-conversation' } }
  let sequence = 0
  const commit = (items: AgentSessionHistoryItem[], selected = source, reverse = false) => {
    const page = publicationPage(boundary, { ...native, source: selected, cursor: 'page-' + ++sequence }, items)
    // These controlled revisions retain the public reader's original native page position.
    for (const unit of page.units) for (const record of unit.records) if (record.order.kind === 'native-page') record.order.pageWitness = 'original-page'
    store.commitPage(boundary, store.checkpoint(boundary, 'local'), page.page, () => true, { ...page, ...(metadata ? { replyMetadata: true as const } : {}), units: reverse ? [...page.units].reverse() : page.units })
  }
  const last = () => store.list(boundary).filter(operation => operation.payload.kind === 'speech').at(-1)!
  return { database, store, boundary, commit, last }
}

it('accepted native page order wins over event order, and old record corrections do not replace a later cumulative snapshot', () => {
  const f = fixture()
  f.commit([usage('early', 8), usage('latest', 20), answer()], source, true)
  expect(f.last().payload).toMatchObject({ replyMetadata: { metrics: { scope: 'turn', usage: { outputTokens: 20 } } } })
  expect(f.store.qualifyPending(f.boundary, f.last(), new Map(), f.store.checkpoint(f.boundary, 'local'))).toBe('qualified')
  f.commit([usage('early', 90), answer('second')])
  expect(f.last().payload).toMatchObject({ replyMetadata: { metrics: { usage: { outputTokens: 20 } } } })
  const snapshots = f.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='reply-snapshot'").all().map(row => JSON.parse(String(row.decision_json)))
  expect(snapshots.length).toBeGreaterThan(0)
  expect(snapshots.every(snapshot => !('facts' in snapshot) && snapshot.witnesses.length <= 3)).toBe(true)
  const query = f.database.prepare("EXPLAIN QUERY PLAN SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND json_extract(decision_json,'$.kind') IN ('reply-fact','reply-projection') AND json_extract(decision_json,'$.kind')='reply-fact' AND json_extract(decision_json,'$.turnKey')=?").all('binding', 1, 'turn')
  expect(JSON.stringify(query)).toContain('SEARCH'); expect(JSON.stringify(query)).toContain('connector_publication_reply_turn')
})

it('a previously metric-free earlier record cannot become the latest cumulative sample when its original revision gains metrics', () => {
  const f = fixture(), early = usage('previously-empty', 10)
  delete early.metrics
  f.commit([early, usage('later', 20), answer()])
  f.commit([usage('previously-empty', 10), answer('second')])
  expect(f.last().payload).toMatchObject({ replyMetadata: { metrics: { usage: { outputTokens: 20 } } } })
})

it('equal native turn and record IDs in another provider source cannot replace the original reply metrics', () => {
  const records = [source, { providerId: 'claude', nativeSessionId: 'other-native' }].map((selected, index) => projectConversationTimeline({ agentSessionId: 'agent', executionHostId: 'local',
    historyPage: { agentSessionId: 'agent', source: selected, items: [usage('same-id', index ? 999 : 22)], nextCursor: null } }).records[0]!)
  const witness = replyRecord(records[0]!, 'local', 'agent')!, projection: ReplyProjection = { kind: 'reply-projection', projectionId: 'projection', ...witness }
  const facts: ReplyFact[] = records.map(record => ({ kind: 'reply-fact', ...replyRecord(record, 'local', 'agent')!, metrics: record.original.kind === 'native' ? record.original.item.metrics : undefined }))
  expect(replyMetadata(projection, facts).metadata).toMatchObject({ metrics: { usage: { outputTokens: 22 } } })
})

it('response metrics require the exact record revision and turn outcomes do not come from final phase', () => {
  const record = projectConversationTimeline({ agentSessionId: 'agent', executionHostId: 'local', historyPage: { agentSessionId: 'agent', source, items: [answer()], nextCursor: null } }).records[0]!
  const witness = replyRecord(record, 'local', 'agent')!, projection: ReplyProjection = { kind: 'reply-projection', projectionId: 'projection', ...witness }
  const facts: ReplyFact[] = [{ kind: 'reply-fact', ...witness, revision: 'old-revision', metrics: { scope: 'response', usage: { outputTokens: 99 } } }]
  expect(replyMetadata(projection, facts).metadata).toEqual({ agentSessionId: 'agent' })
  facts.push({ kind: 'reply-fact', ...witness, metrics: { scope: 'response', usage: { outputTokens: 0 } } })
  expect(replyMetadata(projection, facts).metadata).toEqual({ agentSessionId: 'agent', metrics: { scope: 'response', usage: { outputTokens: 0 } } })
  expect(replyRecord(record, 'other-host', 'agent')).toBeUndefined()
  expect(replyRecord(record, 'local', 'other-agent')).toBeUndefined()
  const turns: ReplyFact[] = ['first-page', 'incomparable-page'].map((pageWitness, index) => ({ kind: 'reply-fact', ...witness,
    recordKey: 'usage-' + index, metrics: { scope: 'turn', usage: { outputTokens: index ? 30 : 20 } }, order: { kind: 'native-page', source, pageWitness, indexInPage: 0 } }))
  turns.push({ kind: 'reply-fact', ...witness, recordKey: 'duration', metrics: { scope: 'turn', durationMs: 100 }, outcome: 'completed' })
  expect(replyMetadata(projection, turns).metadata).toEqual({ agentSessionId: 'agent', outcome: 'completed', metrics: { scope: 'turn', durationMs: 100 } })
})

it.each([false, true])('cancelled original body requalifies and prepares after its source becomes available (metadata=%s)', metadata => {
  const f = fixture(metadata)
  f.commit([answer()])
  const original = f.last()
  // Retain a previous writer's unresolved representation. The real qualifier,
  // rather than a manufactured operation state, owns its cancellation.
  f.database.prepare("UPDATE connector_publication_decision SET decision_json=json_remove(decision_json,'$.purpose','$.contentEligibility') WHERE json_extract(decision_json,'$.kind')='representation'").run()
  expect(f.store.qualifyPending(f.boundary, original, new Map(), f.store.checkpoint(f.boundary, 'local'))).toBe('cancelled')
  expect(f.store.inspect(original.operationId)?.state).toBe('cancelled')
  f.commit([answer()])
  const recovered = f.last()
  expect(recovered.operationId).not.toBe(original.operationId); expect(recovered.state).toBe('pending')
  expect(f.store.qualifyPending(f.boundary, recovered, new Map(), f.store.checkpoint(f.boundary, 'local'))).toBe('qualified')
  const claimed = f.store.claimNext(f.boundary, recovered.operationId, () => true, new FeishuAdapter().publication)
  expect(claimed?.state).toBe('dispatching'); expect(claimed?.prepared?.request.method).toBe('POST')
  expect(f.store.inspect(original.operationId)?.state).toBe('cancelled')
})
