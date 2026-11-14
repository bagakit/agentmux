import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { PublicationStore, type PublicationOperation } from '../src/publication-store.js'
import { deliveryFact } from '../../core/test/fixtures/connection-delivery.js'
import { parseMoteChatResult } from '../../core/src/mote/chat-codec.js'
import type { MoteChatInspection } from '../../core/src/mote/chat-contract.js'
import { moteChatJourneyFixture } from './fixtures/mote-chat-journey.js'

const cleanup: Array<() => Promise<void> | void> = []
const facts: unknown[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
afterAll(async () => {
  if (process.env.MOTE_REPLY_SQL_FACTS) await writeFile(process.env.MOTE_REPLY_SQL_FACTS, JSON.stringify({ node: process.versions.node,
    nodeSQLite: process.versions.sqlite, facts }, null, 2) + '\n')
})

function operation(id: string, projection: string, state: PublicationOperation['state'] = 'pending', extra: Partial<PublicationOperation> = {}): PublicationOperation {
  const original = deliveryFact(id)
  return { ...original, projectionId: projection, sourceRevision: id,
    reference: { ...original.reference, source: { kind: 'mote-chat-reply', operationId: 'reply-' + projection, ingressId: 'ingress-' + projection } },
    payload: { kind: 'speech', text: 'Original authored reply for ' + id }, state, ...extra }
}
function insert(database: DatabaseSync, value: PublicationOperation): void {
  database.prepare('INSERT INTO connector_publication_operation(operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
    .run(value.operationId, value.projectionId, value.sourceRevision, value.fragment.ordinal, value.bindingId, value.bindingRevision, JSON.stringify(value), value.state)
  if (value.attempt) database.prepare('INSERT INTO connector_publication_attempt(operation_id,attempt,receipt_json) VALUES (?,?,?)')
    .run(value.operationId, value.attempt, value.receipt ? JSON.stringify(value.receipt) : null)
}
const rateLimited = (): Partial<PublicationOperation> => ({ reason: 'rate-limited', attempt: 1,
  receipt: { state: 'not-applied', reason: 'rate-limited' },
  prepared: { adapterId: 'sample', renderVersion: 'original', requestKey: 'original-request', request: { method: 'POST', path: '/messages' } },
  rateLimit: { source: { kind: 'message', attempt: 1 }, scopeKey: 'original-native-scope', notBefore: Date.now() + 60_000, basis: 'native', reason: 'rate-limit' } })

it('mote reply query preserves exact eligibility, original receipts and earliest heads across audiences', () => {
  const database = new DatabaseSync(':memory:'), store = new PublicationStore(database)
  cleanup.push(() => database.close())
  const closed = operation('closed-before-live', 'a', 'confirmed')
  const dispatching = operation('dispatching-original', 'a', 'dispatching', { attempt: 1 })
  const next = operation('next-fragment', 'a', 'pending', { fragment: { ordinal: 1, count: 2 } })
  const unknown = operation('unknown-original', 'b', 'unknown', { attempt: 1, receipt: { state: 'unknown', reason: 'effect-unconfirmed' } })
  const afterUnknown = operation('after-unknown', 'b', 'pending', { fragment: { ordinal: 1, count: 2 } })
  const cooling = operation('qualified-rate-limit', 'c', 'not-applied', rateLimited())
  const otherAudience = operation('other-original-audience', 'd', 'pending', { bindingId: 'another-binding', bindingRevision: 4,
    target: { ...deliveryFact().target, externalConversationId: 'another-original-room' } })
  const withoutPrepared = rateLimited(); delete withoutPrepared.prepared
  const mismatchedAttempt = rateLimited(); mismatchedAttempt.attempt = 2
  const excluded = [closed, operation('cancelled-original', 'cancelled', 'cancelled'),
    operation('ordinary-original', 'ordinary', 'pending', { reference: deliveryFact().reference }),
    operation('missing-prepared', 'missing', 'not-applied', withoutPrepared),
    operation('wrong-attempt', 'attempt', 'not-applied', mismatchedAttempt),
    operation('unqualified-refusal', 'refusal', 'not-applied', { reason: 'effect-unconfirmed' })]
  for (const value of [closed, dispatching, next, unknown, afterUnknown, cooling, otherAudience, ...excluded.slice(1)]) insert(database, value)
  const retained = excluded.map(value => store.inspect(value.operationId))
  const selected = store.pendingMoteReplies()
  expect(selected.map(value => value.operationId)).toEqual([dispatching.operationId, unknown.operationId, cooling.operationId, otherAudience.operationId])
  expect(selected.map(value => ({ id: value.operationId, body: value.payload, audience: value.target, receipt: value.receipt })))
    .toEqual([dispatching, unknown, cooling, otherAudience].map(value => ({ id: value.operationId, body: value.payload, audience: value.target, receipt: value.receipt })))
  expect(store.pendingMoteReplies().map(value => value.operationId)).toEqual(selected.map(value => value.operationId))
  // Only the original attempt's authoritative receipt advances the next fragment.
  store.settle(dispatching.operationId, 1, { state: 'confirmed', mapping: { messageId: 'original-dispatch-message' } })
  expect(store.pendingMoteReplies().map(value => value.operationId)).toEqual([next.operationId, unknown.operationId, cooling.operationId, otherAudience.operationId])
  store.settle(unknown.operationId, 1, { state: 'confirmed', mapping: { messageId: 'original-unknown-message' } })
  expect(store.pendingMoteReplies().map(value => value.operationId)).toEqual([next.operationId, afterUnknown.operationId, cooling.operationId, otherAudience.operationId])
  expect(excluded.map(value => store.inspect(value.operationId))).toEqual(retained)
  facts.push({ kind: 'semantics', selected: selected.map(value => value.operationId), unknownReceipt: unknown.receipt,
    finalHeads: store.pendingMoteReplies().map(value => value.operationId), excluded: excluded.map(value => value.operationId), authoritativeReceiptAdvance: true })
})

it.each([false, true])('mote reply query work ignores unrelated completed history with pending=%s', async pending => {
  const root = await mkdtemp(join(tmpdir(), 'mote-reply-query-')), file = join(root, 'journal.sqlite')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const database = new DatabaseSync(file), store = new PublicationStore(database)
  cleanup.push(() => database.close())
  const prepare = database.prepare.bind(database), reads: Array<{ sql: string; ids: string[] }> = []
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql)
    if (sql.startsWith('SELECT operation_json,state') && sql.includes('SELECT MIN(ordinal)') && sql.includes('GROUP BY projection_id')) {
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation(() => {
        const rows = all()
        reads.push({ sql, ids: rows.map(row => JSON.parse(String(row.operation_json)).operationId) })
        return rows
      })
    }
    return statement
  })
  const expected: string[] = []
  if (pending) for (const [id, projection, state, extra] of [
    ['pending-head', 'one', 'pending', {}], ['pending-tail', 'one', 'pending', {}],
    ['unknown-head', 'two', 'unknown', { attempt: 1, receipt: { state: 'unknown', reason: 'effect-unconfirmed' } }],
    ['rate-head', 'three', 'not-applied', rateLimited()]
  ] as const) {
    insert(database, operation(id, projection, state, extra))
    if (id !== 'pending-tail') expected.push(id)
  }
  const costs: Array<{ historyRows: number; steps: number; rows: number; sqliteVersion: string }> = []
  let historyRows = 0
  for (const add of [0, 256, 3840]) {
    database.exec('BEGIN')
    for (let index = 0; index < add; index++) insert(database, operation('retained-' + historyRows, 'closed-' + historyRows++, 'confirmed', {
      reference: deliveryFact().reference, payload: { kind: 'speech', text: 'Retained unrelated completed original message. '.repeat(24) } }))
    database.exec('COMMIT')
    expect(store.pendingMoteReplies().map(value => value.operationId)).toEqual(expected)
    const actual = reads.at(-1)!
    // Reuse the established cost fixture: actual executed SQL, same private journal,
    // a separately versioned read-only SQLite connection, and VM steps rather than ms.
    const count = JSON.parse(execFileSync('python3', ['-c', `import json,sqlite3,sys
x=json.load(sys.stdin)
c=sqlite3.connect('file:'+x['file']+'?mode=ro',uri=True)
steps=0
def tick():
 global steps
 steps+=1
 return 0
c.set_progress_handler(tick,1)
rows=c.execute(x['sql']).fetchall()
c.set_progress_handler(None,0)
print(json.dumps({'steps':steps,'rows':len(rows),'sqliteVersion':sqlite3.sqlite_version}))
c.close()`], { input: JSON.stringify({ file, sql: actual.sql }), encoding: 'utf8' })) as { steps: number; rows: number; sqliteVersion: string }
    costs.push({ historyRows, ...count })
  }
  const query = reads.at(-1)!, plans = prepare('EXPLAIN QUERY PLAN ' + query.sql).all()
  facts.push({ kind: 'history-cost', pending, costs, plans, sql: query.sql, selected: query.ids,
    boundary: 'Actual PublicationStore query/schema; synthetic retained corpus; Python VM work is versioned separately from Node/live SQLite and is not a live timing or RSS claim.' })
  expect(costs.every(value => value.rows === expected.length)).toBe(true)
  const baseline = costs[0]!.steps
  expect(costs.at(-1)!.steps, 'Unrelated completed history must not multiply original Mote recovery VM work')
    .toBeLessThanOrEqual(baseline + Math.max(8, baseline * 0.2))
  expect(plans.filter(row => String(row.detail).includes('SCAN connector_publication_operation')).every(row => String(row.detail).includes('connector_publication_mote_reply'))).toBe(true)
  expect(plans.some(row => String(row.detail).includes('connector_publication_mote_reply'))).toBe(true)
})

it('mote reply query feeds the real public CLI and original Host with every authored fragment and receipt', async () => {
  const f = await moteChatJourneyFixture(4, 60_000, 'headless', false, 'grok', undefined, 'bound', 'signed-room')
  expect(await f.wire.post(f.message('original-sql-question'))).toBe(202)
  const original = await f.claimed('original-sql-question')
  const database = f.services.database!, prepare = database.prepare.bind(database), reads: Array<{ sql: string; ids: string[] }> = []
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql)
    if (sql.includes('SELECT MIN(ordinal)') && sql.includes('connector_publication_mote_reply')) {
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation(() => { const rows = all(); reads.push({ sql, ids: rows.map(row => JSON.parse(String(row.operation_json)).operationId) }); return rows })
    }
    return statement
  })
  const input = { operationId: 'original-query-reply', ingressId: original.ingressId, body: 'Every original authored fragment stays in order. '.repeat(600) }
  const reply = parseMoteChatResult('space.mote.chat.reply', await f.cli('reply', input, f.credentials(0)), input)
  expect(reply.operation.deliveryOperationIds.length).toBeGreaterThan(1)
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(reply.operation.deliveryOperationIds.length))
  expect(f.wire.effects.map(effect => effect.text).join('')).toBe(input.body)
  expect(f.wire.effects.every(effect => effect.room === original.externalConversationId)).toBe(true)
  let inspection: MoteChatInspection | undefined
  await vi.waitFor(async () => { inspection = parseMoteChatResult('space.mote.chat.inspect', await f.cli('inspect', { operationId: input.operationId }, f.credentials(0)), { operationId: input.operationId }); expect(inspection.deliveries?.every(value => value.state === 'confirmed')).toBe(true) })
  expect(inspection?.deliveries).toHaveLength(reply.operation.deliveryOperationIds.length)
  if (!inspection?.deliveries) throw new Error('The original public reply inspection has no delivery receipts')
  expect(reads.some(read => read.ids.some(id => reply.operation.deliveryOperationIds.includes(id))), 'The actual public reply must visit the original pending-Mote SQL owner').toBe(true)
  facts.push({ kind: 'public-consumer', bodyCodeUnits: input.body.length, expectedEffects: reply.operation.deliveryOperationIds.length,
    actualEffects: f.wire.effects.length, deliveries: inspection.deliveries.map(value => ({ operationId: value.operationId, state: value.state, source: value.reference.source })),
    executedReads: reads, publicCLI: true, originalHost: true, originalAudience: true })
})
