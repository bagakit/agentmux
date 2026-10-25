import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { beginCapturedStream, readyCapturedStream, commitCapturedMutation } from '../src/captured-history.js'
import { consumeConversationWindowPage, type ConversationTimelineReadInput } from '../src/conversation.js'
import { capturedStorageSession } from './helpers/captured-history-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const closes: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  try { vi.restoreAllMocks() } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Captured read fixture cleanup failed')
})
afterAll(async () => { if (process.env.CAPTURED_READ_FACTS) await writeFile(process.env.CAPTURED_READ_FACTS, JSON.stringify(facts, null, 2) + '\n') })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-cr-')); closes.push(() => rm(root, { recursive: true, force: true }))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), session = capturedStorageSession(root)
  await store.compareAndSwap(null, session)
  const item = { id: 'original-record', agentSessionId: session.agentSessionId, kind: 'user_message' as const, source: 'user' as const,
    status: 'complete' as const, title: 'Original input', content: 'Original A', createdAt: 1, updatedAt: 1, authorHuman: true }
  await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item })
  const client = new AgentMuxClient({ store }); closes.push(() => client.dispose())
  const controls = ['connect', 'startAgentSession', 'resumeAgentSession', 'stopAgentSession', 'sendAgentMessage']
    .filter(key => typeof (client as unknown as Record<string, unknown>)[key] === 'function').map(key => vi.spyOn(client, key as 'connect'))
  const db = new DatabaseSync(store.path); closes.push(() => db.close())
  const reference = { hostId: 'local', agentSessionId: session.agentSessionId }
  const first = (await store.readCapturedHistory(session.agentSessionId, { limit: 1 })).records[0]!
  const mutate = (content: string) => commitCapturedMutation(db, { type: 'upsert', agentSessionId: session.agentSessionId, item: { ...item, content } })
  return { root, store, session, item, client, db, reference, first, mutate, controls }
}

it('exact captured versions preserve original cut, recurrence and subject boundaries', async () => {
  const f = await fixture(), sid = f.session.agentSessionId
  const b = f.mutate('Original B'), again = f.mutate('Original A')
  expect(again.position.revision).toBe(f.first.revision)
  const stream = again.stream, exact = (cut: number, revision = f.first.revision, recordId = f.item.id) =>
    f.store.readCapturedHistory(sid, { epoch: stream.epoch, throughSequence: cut, recordId, recordRevision: revision, limit: 1 })
  expect((await exact(0)).records).toEqual([])
  expect((await exact(b.stream.sequence)).records.map(record => record.sequence)).toEqual([f.first.sequence])
  expect((await exact(again.stream.sequence)).records.map(record => record.sequence)).toEqual([again.position.sequence])
  expect((await exact(again.stream.sequence, '0'.repeat(64))).records).toEqual([])
  const anotherRecord = commitCapturedMutation(f.db, { type: 'append', agentSessionId: sid, item: { ...f.item, id: 'other-record', content: 'Other record' } })
  expect((await exact(anotherRecord.stream.sequence, anotherRecord.position.revision)).records).toEqual([])
  const other = 'other-session'; beginCapturedStream(f.db, other, null); readyCapturedStream(f.db, other, null, 0, [])
  const foreign = commitCapturedMutation(f.db, { type: 'append', agentSessionId: other, item: { ...f.item, agentSessionId: other, content: 'Other Session' } })
  expect((await exact(anotherRecord.stream.sequence, foreign.position.revision)).records).toEqual([])
  await expect(f.store.readCapturedHistory(sid, { epoch: 'other-epoch', recordId: f.item.id, recordRevision: f.first.revision })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(exact(anotherRecord.stream.sequence + 1)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  f.db.prepare("UPDATE captured_streams SET state='preparing' WHERE session_id=?").run(sid)
  // Read the same original storage owner without invoking a new import or repair.
  const { readCapturedPage } = await import('../src/captured-history.js')
  expect(() => readCapturedPage(f.db, sid, { recordId: f.item.id, recordRevision: f.first.revision })).toThrow(expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_CAPTURE_UNCONFIRMED' }))
  f.db.prepare("UPDATE captured_streams SET state='ready' WHERE session_id=?").run(sid)
  expect(await f.store.readMetadata(sid)).toEqual(f.session)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('public conversation anchors seek exact captured versions with bounded work as later revisions grow', async () => {
  const f = await fixture(), sid = f.session.agentSessionId
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const opening = consumeConversationWindowPage(await f.client.readAgentConversation(f.reference))
  expect(opening.kind).toBe('complete'); if (opening.kind !== 'complete') throw Error('Original window incomplete')
  const original = opening.snapshot.units.flatMap(unit => unit.records).find(record => record.reference?.source.recordId === f.item.id)!
  expect(original).toBeDefined(); expect(original.revision).toBe(f.first.revision)
  const queries: Array<{ sql: string; parameters: SQLInputValue[] }> = []
  const prepare = DatabaseSync.prototype.prepare
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql)
    if (sql.includes('captured_record_versions v') && sql.includes('LIMIT 1') && (new Error().stack ?? '').includes('readCapturedPage')) {
      const all = statement.all.bind(statement)
      statement.all = (...parameters) => { const values = parameters as SQLInputValue[]; queries.push({ sql, parameters: values }); return all(...values) }
    }
    return statement
  })
  const costs: Array<{ laterRevisions: number; cases: Array<{ name: string; steps: number; rows: number }>; sqliteVersion: string }> = []
  let laterRevisions = 0, finalInput!: ConversationTimelineReadInput
  const assertOriginal = (page: Awaited<ReturnType<typeof f.client.readAgentConversation>>) => {
    const read = consumeConversationWindowPage(page); expect(read.kind).toBe('complete')
    if (read.kind !== 'complete') throw Error('Original anchor read incomplete')
    const record = read.snapshot.units.flatMap(unit => unit.records).find(record => record.reference?.source.recordId === f.item.id)!
    expect(record).toMatchObject({ reference: original.reference, revision: original.revision, original: original.original })
  }
  for (const grow of [0, 256, 1792]) {
    f.db.exec('BEGIN')
    for (let n = 0; n < grow; n++) f.mutate('Later original revision ' + ++laterRevisions)
    f.db.exec('COMMIT')
    const frontier = (await f.client.conversationCheckpoint(f.reference)).checkpoint
    finalInput = { ...f.reference, anchor: { record: original.reference!, revision: original.revision, frontier } }
    assertOriginal(await f.client.readAgentConversation(finalInput))
    const read = queries.at(-1); expect(read, 'The actual Core anchor reader must execute the captured exact query').toBeDefined()
    const result = JSON.parse(execFileSync('python3', ['-c', `import json,sqlite3,sys
x=json.load(sys.stdin)
c=sqlite3.connect('file:'+x['file']+'?mode=ro',uri=True)
results=[]
for name,params in [('original',x['parameters']),('missing',x['parameters'][:3]+['0'*64]+x['parameters'][4:])]:
 steps=[0]
 def tick():
  steps[0]+=1
  return 0
 c.set_progress_handler(tick,1)
 rows=c.execute(x['sql'],params).fetchall()
 c.set_progress_handler(None,0)
 results.append({'name':name,'steps':steps[0],'rows':len(rows)})
print(json.dumps({'cases':results,'sqliteVersion':sqlite3.sqlite_version}))
c.close()`], { input: JSON.stringify({ file: f.store.path, ...read }), encoding: 'utf8' }))
    costs.push({ laterRevisions, ...result })
  }
  for (const name of ['original', 'missing']) {
    const values = costs.map(cost => cost.cases.find(value => value.name === name)!)
    expect(values.every(value => value.rows === (name === 'original' ? 1 : 0))).toBe(true)
    expect(values.at(-1)!.steps, name + ' lookup must not scan later unrelated revisions').toBeLessThan(values[0]!.steps * 1.2)
  }
  const last = queries.at(-1)!, plan = prepare.call(f.db, 'EXPLAIN QUERY PLAN ' + last.sql).all(...last.parameters)
  expect(plan.some(row => String(row.detail).includes('captured_exact_version') && String(row.detail).includes('revision=?'))).toBe(true)
  assertOriginal(await rpc.call('agent.conversation.inspect', finalInput))
  const compiledCli = new URL('../dist/agentmux.js', import.meta.url), compiledCliSha256 = createHash('sha256').update(await readFile(compiledCli)).digest('hex')
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'conversation', 'inspect', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(finalInput))
  expect(cli.code, cli.stderr).toBe(0); assertOriginal(JSON.parse(cli.stdout).result)
  expect(createHash('sha256').update(await readFile(compiledCli)).digest('hex')).toBe(compiledCliSha256)
  const missing = await rpc.call('agent.conversation.inspect', { ...finalInput, anchor: { ...finalInput.anchor!, revision: '0'.repeat(64) } })
  expect(missing.coverage.flatMap(coverage => coverage.gaps)).toContainEqual(expect.objectContaining({ code: 'AGENT_CONVERSATION_VERSION_UNAVAILABLE' }))
  expect(await f.store.readMetadata(sid)).toEqual(f.session)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  facts.push({ costs, actualQuery: last, plan, originalRevision: original.revision, finalInput, compiledCli: { entry: 'packages/core/bin/amux', module: 'packages/core/dist/agentmux.js', sha256: compiledCliSha256 },
    boundary: 'Actual original Session Store, captured mutation writer, Core conversation anchor, public RPC and compiled CLI. Python VM steps read the same isolated journal; Node EXPLAIN qualifies the actual query. No Native lifecycle operation.' })
}, 20_000)
