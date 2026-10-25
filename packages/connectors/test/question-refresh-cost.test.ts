import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'
import { permissionActionsFixture } from './fixtures/permission-actions.js'
import { savedQuestionEvent, savedQuestionJsonl } from '../../core/test/helpers/codex-saved-question.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('default Host refresh preserves latest Question semantics without scanning unrelated publication history', async () => {
  const f = await permissionActionsFixture(); cleanup.push(f.close)
  await f.grant(['answer'])
  const event = savedQuestionEvent(); event.payload.thread_id = 'original-native'
  await appendFile(join(f.original.root, 'native.jsonl'), savedQuestionJsonl([event]))
  f.services.publication!.refresh()
  const store = f.services.publication!.store
  await vi.waitFor(() => expect(store.list(f.binding).some(value => value.payload.kind === 'question' && value.state === 'confirmed')).toBe(true))
  const question = store.list(f.binding).find(value => value.payload.kind === 'question' && value.state === 'confirmed')!
  expect(question.payload).toMatchObject({ status: 'pending', actionRef: expect.any(String) })
  const database = f.services.database!, prepare = database.prepare.bind(database)
  const reads: Array<{ sql: string; parameters: SQLInputValue[]; ids: string[] }> = []
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql)
    if (sql.includes("'$.payload.status'") && sql.includes('LIMIT 100')) {
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...parameters: SQLInputValue[]) => {
        const rows = all(...parameters)
        reads.push({ sql, parameters, ids: rows.map(row => JSON.parse(String(row.operation_json)).operationId) })
        return rows
      })
    }
    return statement
  })
  const insert = prepare('INSERT INTO connector_publication_operation(operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
  const add = (id: string, projection: string, payload: unknown, binding = f.binding.bindingId, revision = f.binding.revision, effect = 'upsert') => {
    // Retained historical corpus only. Production selection and original live
    // Question updates still execute through the default Host and SDK adapter.
    const value = { ...question, operationId: id, projectionId: projection, sourceRevision: id, bindingId: binding, bindingRevision: revision, payload, effect }
    insert.run(id, projection, id, 0, binding, revision, JSON.stringify(value), 'confirmed')
  }
  const pending = { kind: 'question', text: 'Retained question', questions: [], status: 'pending' }
  database.exec('BEGIN')
  for (let index = 0; index < 120; index++) {
    add('masked-' + index, 'closed-' + index, pending)
    add('terminal-' + index, 'closed-' + index, index % 2
      ? { ...pending, status: 'response-sent' } : { kind: 'speech', text: '' }, f.binding.bindingId, f.binding.revision, index % 2 ? 'upsert' : 'withdraw')
  }
  add('live-pending', 'live-pending', pending)
  add('live-unconfirmed', 'live-unconfirmed', { ...pending, status: 'unconfirmed' })
  add('foreign', 'foreign', pending, 'another-binding')
  add('foreign-revision', 'foreign-revision', pending, f.binding.bindingId, f.binding.revision + 1)
  // A similarly named projection in another scope cannot hide this live item.
  add('foreign-successor', 'live-pending', { ...pending, status: 'response-sent' }, 'another-binding')
  database.exec('COMMIT')
  const wake = async () => {
    const start = reads.length; f.services.publication!.refresh()
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(start))
    return reads.at(-1)!
  }
  const first = await wake()
  const expected = [question.operationId, 'live-pending', 'live-unconfirmed']
  expect(first.ids, 'Answered/withdrawn predecessors must not take the bounded pending result or hide later live questions').toEqual(expected)

  const file = String(prepare('PRAGMA database_list').get()!.file)
  const costs: Array<{ rowsAdded: number; steps: number; rows: number; sqliteVersion: string }> = []
  const measure = (rowsAdded: number) => {
    // Count actual VM work against the same isolated journal using Python's
    // read-only SQLite connection; record its version separately from Node.
    const value = JSON.parse(execFileSync('python3', ['-c', `import json,sqlite3,sys
x=json.load(sys.stdin)
c=sqlite3.connect('file:'+x['file']+'?mode=ro',uri=True)
steps=0
def tick():
 global steps
 steps+=1
 return 0
c.set_progress_handler(tick,1)
rows=c.execute(x['sql'],x['parameters']).fetchall()
c.set_progress_handler(None,0)
print(json.dumps({'steps':steps,'rows':len(rows),'sqliteVersion':sqlite3.sqlite_version}))
c.close()`], { input: JSON.stringify({ file, sql: first.sql, parameters: first.parameters }), encoding: 'utf8' }))
    costs.push({ rowsAdded, ...value })
  }
  measure(0)
  for (const count of [2000, 8000]) {
    database.exec('BEGIN')
    for (let index = 0; index < count; index++) add(`speech-${count}-${index}`, `speech-${count}-${index}`, { kind: 'speech', text: 'Unrelated completed speech.' })
    database.exec('COMMIT')
    const next = await wake(); expect(next.ids).toEqual(expected); measure(countsTotal(costs) + count)
  }
  const plans = prepare('EXPLAIN QUERY PLAN ' + first.sql).all(...first.parameters)
  const facts = { sql: first.sql, parameters: first.parameters, costs, plans, selected: first.ids,
    nodeSqliteVersion: prepare('SELECT sqlite_version() version').get()!.version,
    boundary: 'Actual default Host/ConversationActions/PublicationStore/official SDK; controlled Runtime and platform transport. Historical corpus is isolated fixture data. Candidate history remains a real cost.' }
  const output = resolve(process.env.QUESTION_REFRESH_PROOF ?? '.local/channel-current-session-regression/question-refresh-cost/positive')
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'cost.json'), JSON.stringify(facts, null, 2) + '\n')
  expect(costs.every(value => value.rows === expected.length)).toBe(true)
  expect(costs.at(-1)!.steps, 'Unrelated speech history must not multiply Question refresh VM work').toBeLessThan(costs[0]!.steps * 1.2)
  expect(plans.some(row => String(row.detail).includes('connector_publication_question_candidate'))).toBe(true)
  expect(plans.some(row => String(row.detail).includes('connector_publication_projection_latest'))).toBe(true)
  const before = await f.cli(['connection', 'delivery', 'inspect', '--operation-id', question.operationId])
  expect(JSON.stringify(before)).toContain(question.mapping!.messageId)
  await f.grant([], 1); await wake()
  await vi.waitFor(() => expect(store.latestProjection(question.projectionId)).toMatchObject({ state: 'confirmed', payload: { kind: 'question', status: 'unavailable' } }))
  const latest = store.latestProjection(question.projectionId)!
  expect(latest.operationId).not.toBe(question.operationId)
  expect(f.effects.some(value => value.method === 'PATCH')).toBe(true)
  const after = await f.cli(['connection', 'delivery', 'inspect', '--operation-id', latest.operationId])
  expect(JSON.stringify(after)).toContain(latest.mapping!.messageId)
  await writeFile(join(output, 'consumer.json'), JSON.stringify({ before, after, effects: f.effects }, null, 2) + '\n')
})

function countsTotal(costs: Array<{ rowsAdded: number }>): number { return costs.at(-1)!.rowsAdded }
