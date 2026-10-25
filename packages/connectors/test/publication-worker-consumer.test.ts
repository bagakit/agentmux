import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { createConnectionServices } from '../src/connection-services.js'
import { ConnectionHost } from '../src/connection-host.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'
import type { PublicationReceipt, PublicationMapping, PublicationOperation } from '../src/publication-store.js'
import type { PublicationSpeakerReader } from '../src/publication-speaker.js'
import { PublicationStore } from '../src/publication-store.js'
import { config, roomBindingFixture, core } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { AgentMuxError } from '../../core/dist/errors.js'
import { connectAgentMuxRpc } from '../../core/dist/public-rpc-client.js'
import { connectionDiagnosisRecordKey, connectionDiagnosisEventKey, connectionDiagnosisCheckpointKey, formatGroupDiagnosis } from '../../core/dist/connections.js'
import * as conversationStream from '../../core/dist/conversation-stream.js'

const cleanup: Array<() => void | Promise<void>> = []
let recentDeliveryFacts: unknown
const recoveryCostFacts: unknown[] = []
const cardRecoveryFacts: unknown[] = []
const decisionLookupFacts: unknown[] = []
const wireBudgetFacts: unknown[] = []
afterAll(async () => { if (process.env.AGENTMUX_TEST_DELIVERY_ORDER_FACTS) await writeFile(process.env.AGENTMUX_TEST_DELIVERY_ORDER_FACTS, JSON.stringify(recentDeliveryFacts ?? null, null, 2) + '\n') })
afterAll(async () => { if (process.env.AGENTMUX_TEST_PUBLICATION_RECOVERY_FACTS) await writeFile(process.env.AGENTMUX_TEST_PUBLICATION_RECOVERY_FACTS, JSON.stringify(recoveryCostFacts, null, 2) + '\n') })
afterAll(async () => { if (process.env.PUBLICATION_CARD_RECOVERY_FACTS) await writeFile(process.env.PUBLICATION_CARD_RECOVERY_FACTS, JSON.stringify(cardRecoveryFacts, null, 2) + '\n') })
afterAll(async () => { if (process.env.PUBLICATION_DECISION_LOOKUP_FACTS) await writeFile(process.env.PUBLICATION_DECISION_LOOKUP_FACTS, JSON.stringify(decisionLookupFacts, null, 2) + '\n') })
afterAll(async () => { if (process.env.PUBLICATION_WINDOW_BUDGET_FACTS) await writeFile(process.env.PUBLICATION_WINDOW_BUDGET_FACTS, JSON.stringify(wireBudgetFacts, null, 2) + '\n') })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const row = (id: string, text = 'Same original reply', content?: unknown[]) => JSON.stringify({ sessionId: 'original-native', uuid: id,
  type: 'assistant', message: { role: 'assistant', content: content ?? [{ type: 'text', text }] } }) + '\n'
async function fixture(effect?: PublicationAdapter['dispatch'], agentActor = false, speaker?: PublicationSpeakerReader, options: { retired?: boolean } = {}) {
  const original = await roomBindingFixture(true, options); cleanup.push(() => original.close())
  const dispatched: Array<{ request: Parameters<PublicationAdapter['dispatch']>[0]; target: Parameters<PublicationAdapter['dispatch']>[1]; mapping?: Readonly<PublicationMapping> }> = []
  const adapter: PublicationAdapter = { adapterId: 'sample', renderVersion: 'speech-v1', supportedRenderVersions: ['speech-v1'], fragmentBytes: 8_192,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'speech-v1', requestKey: operation.operationId,
      request: { method: operation.effect === 'withdraw' ? 'DELETE' : operation.mapping ? 'PATCH' : 'POST', path: '/messages', contentType: 'application/json',
        body: JSON.stringify({ room: operation.target.externalConversationId, text: operation.payload.text, mapping: operation.mapping }) } }),
    dispatch: async (request, target, credential, signal, mapping) => {
      expect(credential).toBe('original-private-credential')
      if (JSON.parse(request.request.body!).text === undefined) return { state: 'confirmed', mapping: { messageId: 'original-binding-notice' } }
      dispatched.push({ request: structuredClone(request), target: structuredClone(target), ...(mapping ? { mapping: structuredClone(mapping) } : {}) })
      return effect ? await effect(request, target, credential, signal, mapping) : { state: 'confirmed', mapping: JSON.parse(request.request.body!).mapping ?? { messageId: 'message-' + request.requestKey } }
    } }
  const conversation = createPublicationConversationPort(() => [{ hostId: 'local', client: original.client }])
  const services = await createConnectionServices({ directory: join(original.root, 'desktop-publication'),
    adapters: [{ adapterId: 'sample', publication: adapter, test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }],
    bindings: { spatial: original.spatial, checkpoint: original.checkpoint }, publication: conversation, ...(speaker ? { speaker } : {}) })
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'original-credential-entry', secret: 'original-private-credential' })
  await services.connections.configure({ operationId: 'original-configuration', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
  const binding = await services.connections.bindings!.bind(original.input, { actor: agentActor ? { kind: 'agent', id: original.input.agentSessionId } : { kind: 'user', id: 'original-user' } })
  expect(binding.state).toBe('applied'); if (binding.state !== 'applied') throw new Error('Original fixture Binding not applied.')
  await vi.waitFor(() => expect(services.publication!.store.list(binding.binding).some(operation => operation.payload.kind === 'binding-lifecycle' && operation.state === 'confirmed')).toBe(true))
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'publication.sock'), connections: services.connections, spatialState: original.spatial,
    coreClients: () => [{ hostId: 'local', client: original.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(original.root), cli = async (args: string[]) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + join(original.root, 'publication.sock'), 'connection', 'delivery', ...args], env)
    expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result
  }
  const speech = () => services.publication!.store.list(binding.binding).filter(operation => operation.reference.source.kind !== 'binding-operation')
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sdk.dispose())
  const diagnose = async () => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'diagnose', '--host', 'local', '--session', original.session.agentSessionId], env)
    expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result
  }
  return { ...original, services, dispatched, adapter, conversation, binding: binding.binding, cli, speech, sdk, diagnose }
}

it('publication reuses original page validation through the port, worker and durable receipt', async () => {
  const f = await fixture(), digest = conversationStream.conversationRevision
  const counts = { port: 0, workerPage: 0, assembly: 0, storePage: 0, storeUnits: 0 }
  const stackLimit = Error.stackTraceLimit
  Error.stackTraceLimit = 40
  cleanup.push(() => { Error.stackTraceLimit = stackLimit })
  vi.spyOn(conversationStream, 'conversationRevision').mockImplementation(value => {
    const stack = new Error().stack ?? ''
    if (stack.includes('PublicationStore.commitPage')) {
      if (stack.includes('basePage')) counts.storePage++
      else counts.storeUnits++
    } else if (stack.includes('consumeConversationWindowPage')) counts.assembly++
    else if (stack.includes('core-conversation-port.ts')) counts.port++
    else if (stack.includes('PublicationHost.catchUp') && stack.includes('basePage')) counts.workerPage++
    return digest(value)
  })
  await appendFile(f.transcript, row('page-validation-original', 'Original publication body'))
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('confirmed'))
  const operation = f.speech()[0]!
  expect(operation.payload.text).toContain('Original publication body')
  expect(f.dispatched).toHaveLength(1)
  expect(counts.port, 'The actual routed original page must enter strict content validation').toBeGreaterThan(0)
  expect(counts.storeUnits, 'Independently supplied assembled units retain strict commit validation').toBeGreaterThan(0)
  expect(counts.workerPage, 'The worker must reuse the exact original page content validation').toBe(0)
  expect(counts.assembly, 'Assembly must retain validation of complete owned items').toBe(0)
  expect(counts.storePage, 'Commit must recheck the request envelope without rehashing owned items').toBe(0)
  const receipt = await f.sdk.call('connection.delivery.inspect', { operationId: operation.operationId })
  expect(receipt.delivery).toMatchObject({ operationId: operation.operationId, state: 'confirmed' })
  expect(await f.cli(['inspect', '--operation-id', operation.operationId])).toEqual(receipt)
  if (process.env.PUBLICATION_PAGE_REUSE_FACTS) await writeFile(process.env.PUBLICATION_PAGE_REUSE_FACTS,
    JSON.stringify({ counts, deliveries: f.dispatched.length, sdkAndCliReceiptEqual: true }, null, 2) + '\n')
})

it('decision lookup keeps original publication identities and bounded work as unrelated decisions grow', async () => {
  const f = await fixture(), database = f.services.database!, prepare = database.prepare.bind(database)
  const reads: Array<{ kind: 'event' | 'failure'; sql: string; parameters: Parameters<ReturnType<typeof prepare>['get']> }> = []
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql), stack = new Error().stack ?? ''
    const kind = sql.includes("='event-representation'") ? 'event' : sql.includes("='failure-record'") ? 'failure' : undefined
    if (kind && stack.includes('commitPage') && sql.includes('record_id=?')) {
      const get = statement.get.bind(statement)
      statement.get = (...parameters) => { reads.push({ kind, sql, parameters }); return get(...parameters) }
    }
    return statement
  })
  await appendFile(f.transcript, row('decision-cost-original', 'Original decision body'))
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('confirmed'))
  const original = structuredClone(f.speech()[0]!), event = reads.find(read => read.kind === 'event'), failure = reads.find(read => read.kind === 'failure')
  expect(event, 'The actual PublicationHost must consume its event decision lookup').toBeDefined()
  expect(failure, 'The actual PublicationHost must consume its failure decision lookup').toBeDefined()
  const current = JSON.parse(String(prepare(event!.sql).get(...event!.parameters)!.decision_json))
  expect(current.projectionId).toBe(original.projectionId)
  const insert = prepare('INSERT INTO connector_publication_decision(binding_id,binding_revision,source_key,record_id,source_revision,reason,decision_json) VALUES (?,?,?,?,?,?,?)')
  const add = (id: string, revision: string, value: unknown, source = 'unified', binding = f.binding.bindingId, bindingRevision = f.binding.revision) =>
    insert.run(binding, bindingRevision, source, id, revision, 'content-accounted', JSON.stringify(value))
  // Same original event, several retained versions. Latest means publication row order,
  // never lexicographic revision order or an unrelated source with the same local key.
  for (const revision of ['zz-older-fixture', 'aa-latest-fixture']) add(String(event!.parameters[2]), revision,
    { ...current, event: { ...current.event, revision } })
  add(String(event!.parameters[2]), 'foreign-source-version', { ...current, projectionId: 'foreign-source' }, 'other-source')
  add(String(event!.parameters[2]), 'foreign-binding-version', { ...current, projectionId: 'foreign-binding' }, 'unified', 'other-binding')
  add(String(event!.parameters[2]), 'foreign-revision-version', { ...current, projectionId: 'foreign-revision' }, 'unified', f.binding.bindingId, f.binding.revision + 1)
  add(String(failure!.parameters[2]), 'current', { kind: 'failure-record', projectionId: 'foreign-source' }, 'other-source')
  const selected = () => JSON.parse(String(prepare(event!.sql).get(...event!.parameters)!.decision_json))
  expect(selected()).toMatchObject({ projectionId: original.projectionId, event: { revision: 'aa-latest-fixture' } })
  expect(prepare(failure!.sql).get(...failure!.parameters)).toBeUndefined()
  const file = String(prepare('PRAGMA database_list').get()!.file)
  const costs: Array<{ unrelatedDecisions: number; reads: Array<{ kind: string; steps: number; rows: number }>; sqliteVersion: string }> = []
  const measure = (unrelatedDecisions: number) => {
    const result = JSON.parse(execFileSync('python3', ['-c', `import json,sqlite3,sys
x=json.load(sys.stdin)
c=sqlite3.connect('file:'+x['file']+'?mode=ro',uri=True)
results=[]
for query in x['reads']:
 steps=[0]
 def tick():
  steps[0]+=1
  return 0
 c.set_progress_handler(tick,1)
 rows=c.execute(query['sql'],query['parameters']).fetchall()
 c.set_progress_handler(None,0)
 results.append({'kind':query['kind'],'steps':steps[0],'rows':len(rows)})
print(json.dumps({'reads':results,'sqliteVersion':sqlite3.sqlite_version}))
c.close()`], { input: JSON.stringify({ file, reads: [event, failure] }), encoding: 'utf8' }))
    costs.push({ unrelatedDecisions, ...result })
  }
  measure(0)
  let unrelatedDecisions = 0
  for (const count of [256, 1792]) {
    database.exec('BEGIN')
    for (let index = 0; index < count; index++) add('unrelated-decision-' + unrelatedDecisions++, 'current', { kind: 'scope', excluded: [] })
    database.exec('COMMIT'); measure(unrelatedDecisions)
  }
  for (const kind of ['event', 'failure']) {
    const values = costs.map(cost => cost.reads.find(read => read.kind === kind)!)
    expect(values.every(value => value.rows === (kind === 'event' ? 1 : 0))).toBe(true)
    expect(values.at(-1)!.steps, kind + ' lookup must not scan unrelated retained decisions').toBeLessThan(values[0]!.steps * 1.2)
  }
  const plans = [event!, failure!].map(read => ({ kind: read.kind, sql: read.sql, parameters: read.parameters,
    plan: prepare('EXPLAIN QUERY PLAN ' + read.sql).all(...read.parameters) }))
  for (const read of plans) expect(read.plan.some(plan => String(plan.detail).includes('source_key=? AND record_id=?'))).toBe(true)
  expect(selected()).toMatchObject({ projectionId: original.projectionId, event: { revision: 'aa-latest-fixture' } })
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  const receipt = await f.sdk.call('connection.delivery.inspect', { operationId: original.operationId })
  expect(receipt.delivery).toMatchObject({ operationId: original.operationId, state: 'confirmed' })
  expect(await f.cli(['inspect', '--operation-id', original.operationId])).toEqual(receipt)
  await appendFile(f.transcript, row('decision-cost-next', 'Next original decision body'))
  await vi.waitFor(() => expect(f.speech().filter(operation => operation.state === 'confirmed')).toHaveLength(2))
  expect(f.dispatched).toHaveLength(2)
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  decisionLookupFacts.push({ costs, plans, originalOperationId: original.operationId, publicReceipt: receipt,
    latestEventRevision: selected().event.revision, nodeSqliteVersion: prepare('SELECT sqlite_version() version').get()!.version,
    boundary: 'Actual ConnectionServices/PublicationHost/PublicationStore from loaded source, Core transcript reader, public RPC and compiled CLI; controlled external adapter. VM steps read this same isolated journal through Python SQLite.' })
}, 15_000)

it('card recovery keeps original scope and in-flight effects with bounded work as completed history grows', async () => {
  const bytes = Buffer.from('original-avatar'), image = { mimeType: 'image/png' as const, dataBase64: bytes.toString('base64'), byteLength: bytes.length,
    width: 1, height: 1, sha256: createHash('sha256').update(bytes).digest('hex') }
  const f = await fixture(undefined, false, async () => ({ avatar: { observation: 'available', image } }))
  let releaseUpload!: () => void, releaseCreate!: () => void
  const upload = new Promise<void>(done => { releaseUpload = done }), create = new Promise<void>(done => { releaseCreate = done })
  cleanup.push(releaseUpload, releaseCreate)
  const createCard = vi.fn(async () => { await create; return { state: 'confirmed' as const, id: 'original-native-card' } })
  Object.assign(f.adapter, {
    images: { maxBytes: 1024, accepts: () => true, upload: async () => { await upload; return { state: 'confirmed', imageKey: 'original-avatar-key' } } },
    cards: { prepareCreate: f.adapter.prepare, create: createCard, preparePortrait: f.adapter.prepare,
      portrait: async () => ({ state: 'confirmed' }), inspectPortrait: async () => null }
  } satisfies Partial<PublicationAdapter>)
  const database = f.services.database!, store = f.services.publication!.store, prepare = database.prepare.bind(database)
  // Existing production journals can create projection_latest after the card
  // index during upgrades. Reproduce that observed order using the same DDL
  // only in this private fixture; retained rows and query semantics do not change.
  const projectionIndex = String(prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='connector_publication_projection_latest'").get()!.sql)
  database.exec('DROP INDEX connector_publication_projection_latest'); database.exec(projectionIndex)
  const reads: Array<{ sql: string; parameters: Parameters<ReturnType<typeof prepare>['all']>; ids: string[]; host: boolean }> = []
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql), stack = new Error().stack ?? ''
    if (stack.includes('unconfirmedCards') && sql.includes('operation_json')) {
      const all = statement.all.bind(statement), host = stack.includes('cycle')
      statement.all = (...parameters) => {
        const rows = all(...parameters)
        reads.push({ sql, parameters, ids: rows.map(row => JSON.parse(String(row.operation_json)).operationId), host })
        return rows
      }
    }
    return statement
  })
  await appendFile(f.transcript, row('original-card-reply', 'Original card body'))
  await vi.waitFor(() => expect(createCard).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('confirmed'))
  const original = structuredClone(f.speech()[0]!)
  expect(original.cardPreparation?.receipt.state).toBe('dispatching')
  const hostRead = reads.findLast(read => read.host)
  expect(hostRead, 'The actual PublicationHost cycle must consume the card recovery query').toBeDefined()
  const insert = prepare('INSERT INTO connector_publication_operation(operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
  const add = (operationId: string, receipt: NonNullable<PublicationOperation['cardPreparation']>['receipt'] | null,
    bindingId = f.binding.bindingId, bindingRevision = f.binding.revision) => {
    const { cardPreparation, ...body } = original
    const value: PublicationOperation = { ...body, operationId, projectionId: operationId, sourceRevision: operationId, bindingId, bindingRevision,
      prepared: { ...original.prepared!, requestKey: operationId },
      ...(receipt ? { cardPreparation: { ...cardPreparation!, prepared: { ...cardPreparation!.prepared, requestKey: operationId }, receipt } } : {}) }
    insert.run(operationId, value.projectionId, value.sourceRevision, value.fragment.ordinal, bindingId, bindingRevision, JSON.stringify(value), value.state)
    return value
  }
  // These retained rows are isolated journal history derived from the actual
  // original card. Only the production Host/Store owns recovery and receipts.
  database.exec('BEGIN')
  add('abandoned-first', { state: 'dispatching' }); add('abandoned-second', { state: 'dispatching' })
  const excluded = [add('foreign-card', { state: 'dispatching' }, 'foreign-binding'),
    add('other-revision-card', { state: 'dispatching' }, f.binding.bindingId, f.binding.revision + 1),
    add('unknown-card', { state: 'unknown', reason: 'effect-unconfirmed' }), add('confirmed-card', { state: 'confirmed', id: 'confirmed-native-card' }),
    add('not-applied-card', { state: 'not-applied', reason: 'effect-unconfirmed' }), add('ordinary-body', null)]
  database.exec('COMMIT')
  const expected = [original.operationId, 'abandoned-first', 'abandoned-second'].sort()
  expect(store.unconfirmedCards(f.binding).map(value => value.operationId).sort(), 'Card recovery must retain all and only the exact original binding revision').toEqual(expected)
  const file = String(prepare('PRAGMA database_list').get()!.file)
  const costs: Array<{ historyRows: number; steps: number; rows: number; sqliteVersion: string }> = []
  const measure = (historyRows: number) => {
    const result = JSON.parse(execFileSync('python3', ['-c', `import json,sqlite3,sys
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
c.close()`], { input: JSON.stringify({ file, sql: hostRead!.sql, parameters: hostRead!.parameters }), encoding: 'utf8' }))
    costs.push({ historyRows, ...result })
  }
  measure(0)
  let historyRows = 0
  for (const count of [256, 768]) {
    database.exec('BEGIN')
    for (let index = 0; index < count; index++) add('completed-body-' + historyRows++, null)
    database.exec('COMMIT'); measure(historyRows)
  }
  const plans = prepare('EXPLAIN QUERY PLAN ' + hostRead!.sql).all(...hostRead!.parameters)
  const unhintedPlan = prepare('EXPLAIN QUERY PLAN ' + hostRead!.sql.replace(' INDEXED BY connector_publication_card_preparation', '')).all(...hostRead!.parameters)
  const facts = { sql: hostRead!.sql, parameters: hostRead!.parameters, costs, plans, unhintedPlan, selected: expected,
    schemaCondition: { recreatedIndex: 'connector_publication_projection_latest', originalDefinition: projectionIndex, reason: 'Observed existing-journal index creation order' },
    nodeSqliteVersion: prepare('SELECT sqlite_version() version').get()!.version,
    boundary: 'Actual ConnectionServices/PublicationHost/PublicationStore and public receipts. Runtime and adapter effects are controlled. VM steps use a separate read-only Python SQLite connection/version on this same isolated journal.' }
  cardRecoveryFacts.push(facts)
  expect(costs.every(value => value.rows === expected.length)).toBe(true)
  expect(costs.at(-1)!.steps, 'Completed history must not multiply actual card-recovery VM work').toBeLessThan(costs[0]!.steps * 1.2)
  expect(plans.some(plan => String(plan.detail).includes('connector_publication_card_preparation'))).toBe(true)
  const before = reads.length
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(reads.length).toBeGreaterThan(before))
  await vi.waitFor(() => expect(store.inspect('abandoned-second')?.cardPreparation?.receipt.state).toBe('unknown'))
  expect(store.inspect('abandoned-first')?.cardPreparation?.receipt).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
  expect(store.inspect(original.operationId)?.cardPreparation?.receipt.state, 'A current native create must retain its original in-flight receipt').toBe('dispatching')
  for (const value of excluded) expect(store.inspect(value.operationId)).toEqual(value)
  expect(createCard).toHaveBeenCalledOnce(); expect(f.dispatched).toHaveLength(1)
  const receipt = await f.sdk.call('connection.delivery.inspect', { operationId: 'abandoned-first' })
  expect(receipt.delivery).toMatchObject({ operationId: 'abandoned-first', state: 'confirmed', presentation: { entity: { state: 'unknown', reason: 'effect-unconfirmed' } } })
  expect(await f.cli(['inspect', '--operation-id', 'abandoned-first'])).toEqual(receipt)
  releaseCreate(); releaseUpload()
  await vi.waitFor(() => expect(store.inspect(original.operationId)?.cardPreparation?.receipt.state).toBe('confirmed'))
  expect(store.unconfirmedCards(f.binding)).toEqual([])
  measure(historyRows)
  expect(costs.at(-1)!.rows).toBe(0)
  expect(costs.at(-1)!.steps).toBeLessThan(costs[0]!.steps * 1.2)
  expect(createCard).toHaveBeenCalledOnce(); expect(f.dispatched).toHaveLength(1)
  Object.assign(facts, { publicReceipt: receipt, createCalls: createCard.mock.calls.length, bodyDispatches: f.dispatched.length })
}, 15_000)

it('publication recovery keeps original effects while its loaded Host query excludes completed and unrelated history ranges', async () => {
  const f = await fixture(async request => JSON.parse(request.request.body!).text === 'Original uncertain reply'
    ? { state: 'unknown', reason: 'effect-unconfirmed' }
    : { state: 'confirmed', mapping: { messageId: 'native-' + request.requestKey } })
  const inspections: string[] = []
  f.adapter.inspect = async request => { inspections.push(request.requestKey); return null }
  const database = f.services.database!, store = f.services.publication!.store
  const prepare = database.prepare.bind(database)
  const reads: Array<{ sql: string; parameters: unknown[]; result: string | null; host: boolean }> = []
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql), stack = new Error().stack ?? ''
    if (stack.includes('nextUnconfirmed') && sql.includes('operation_json')) {
      const get = statement.get.bind(statement), host = stack.includes('reconcile')
      statement.get = (...parameters: Parameters<typeof get>) => {
        const value = get(...parameters)
        reads.push({ sql, parameters, result: value ? JSON.parse(String(value.operation_json)).operationId : null, host })
        return value
      }
    }
    return statement
  })
  await appendFile(f.transcript, row('recovery-original', 'Original uncertain reply') + row('recovery-independent', 'Independent original reply'))
  await vi.waitFor(() => expect(f.dispatched).toHaveLength(2))
  const originalId = f.dispatched.find(effect => JSON.parse(effect.request.request.body!).text === 'Original uncertain reply')!.request.requestKey
  const independentId = f.dispatched.find(effect => effect.request.requestKey !== originalId)!.request.requestKey
  await vi.waitFor(() => expect(store.inspect(originalId)?.state).toBe('unknown'))
  await vi.waitFor(() => expect(store.inspect(independentId)?.state).toBe('confirmed'))
  const original = structuredClone(store.inspect(originalId)!)
  await vi.waitFor(() => expect(inspections).toContain(originalId))
  await new Promise<void>(resolve => setImmediate(resolve)) // Let the original null observation release its in-flight slot.
  const insert = prepare('INSERT INTO connector_publication_operation(operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
  // Historical fixture rows never participate in live body dispatch: ordinary
  // recovery excludes binding notices, and foreign rows retain another audience.
  const seed = (label: string, state: string, bindingId = f.binding.bindingId) => {
    database.exec('BEGIN')
    for (let i = 0; i < 5_000; i++) {
      const operationId = label + '-' + i
      insert.run(operationId, label, 'fixture-revision', 0, bindingId, f.binding.revision,
        JSON.stringify({ operationId, reference: { source: { kind: 'binding-operation' } }, payload: { kind: 'binding-lifecycle' } }), state)
    }
    database.exec('COMMIT')
  }
  const costs: Array<{ label: string; medianMs: number; result: null }> = []
  const measure = (label: string) => {
    const samples: number[] = []
    for (let i = 0; i < 24; i++) {
      const before = performance.now(), result = store.nextUnconfirmed(f.binding, originalId)
      const elapsed = performance.now() - before
      expect(result, 'A cursor after the sole unresolved original has no later eligible effect').toBeNull()
      if (i >= 3) samples.push(elapsed)
    }
    samples.sort((a, b) => a - b); costs.push({ label, medianMs: samples[10]!, result: null })
  }
  measure('no-extra-history')
  for (const state of ['confirmed', 'pending', 'not-applied']) { seed(state, state); measure(state + '-growth') }
  seed('foreign-unknown', 'unknown', 'another-binding'); measure('other-binding-growth')
  const beforeWake = inspections.length
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(inspections.length).toBeGreaterThan(beforeWake))
  expect(inspections.every(id => id === originalId)).toBe(true)
  expect(store.inspect(originalId)).toEqual(original)
  expect(f.dispatched).toHaveLength(2)
  const rpc = await f.sdk.call('connection.delivery.inspect', { operationId: originalId })
  expect(rpc.delivery).toMatchObject({ operationId: originalId, state: 'unknown', receipt: { state: 'unknown' } })
  expect(await f.cli(['inspect', '--operation-id', originalId])).toEqual(rpc)
  const delivered = await f.sdk.call('connection.delivery.inspect', { operationId: independentId })
  expect(delivered.delivery).toMatchObject({ operationId: independentId, state: 'confirmed' })
  expect(await f.cli(['inspect', '--operation-id', independentId])).toEqual(delivered)
  const hostRead = reads.findLast(read => read.host && read.result === null)
  expect(hostRead, 'The normal Host reconciliation actually executes the no-result cursor lookup and wraps to the original effect').toBeDefined()
  const plans = prepare('EXPLAIN QUERY PLAN ' + hostRead!.sql).all(...hostRead!.parameters as Parameters<ReturnType<typeof prepare>['all']>)
  recoveryCostFacts.push({ case: 'actual-host', originalId, independentId, inspections, dispatchCount: f.dispatched.length,
    costs, sql: hostRead!.sql, parameters: hostRead!.parameters, plans, publicReceipts: [rpc, delivered], compiledCliMatches: true,
    hostReads: reads.filter(read => read.host), sqliteVersion: prepare('SELECT sqlite_version() version').get()!.version })
  const ranges = plans.map(plan => String(plan.detail)).filter(detail => detail.includes('binding_id=?') && detail.includes('binding_revision=?'))
  expect(ranges.length, 'The real SQLite plan contains scoped original recovery ranges').toBeGreaterThan(0)
  expect(ranges.every(range => range.includes('state=?') && range.includes('ordinal>?')),
    'Recovery work must seek only unresolved states after the original cursor, not walk completed/pending/not-applied audit history').toBe(true)
  expect(plans.some(plan => /SCAN .*connector_publication_operation/u.test(String(plan.detail)))).toBe(false)
}, 35_000)

it('publication recovery preserves both state orders, exact cursor scope and the original projection branch', () => {
  const database = new DatabaseSync(':memory:'); cleanup.push(() => database.close())
  const store = new PublicationStore(database), boundary = { bindingId: 'original-binding', revision: 1 }
  const insert = database.prepare('INSERT INTO connector_publication_operation(operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
  const add = (id: string, state: string, binding = boundary.bindingId, revision = 1, kind = 'native', projection = 'original-projection') =>
    insert.run(id, projection, 'original-revision', 0, binding, revision, JSON.stringify({ operationId: id, reference: { source: { kind } } }), state)
  add('foreign', 'unknown', 'another-binding'); add('revision', 'dispatching', boundary.bindingId, 2)
  add('notice', 'dispatching', boundary.bindingId, 1, 'binding-operation'); add('confirmed', 'confirmed')
  add('first', 'unknown'); add('pending', 'pending'); add('second', 'dispatching'); add('rejected', 'not-applied')
  add('third', 'unknown', boundary.bindingId, 1, 'captured', 'another-projection')
  const cases = [
    [undefined, undefined, 'first'], ['first', undefined, 'second'], ['second', undefined, 'third'], ['third', undefined, null],
    ['foreign', undefined, 'first'], ['revision', undefined, 'first'], ['missing', undefined, 'first'],
    [undefined, 'original-projection', 'notice'], ['first', 'original-projection', 'second'], ['second', 'original-projection', null],
    [undefined, 'another-projection', 'third']
  ] as const
  for (const [after, projection, expected] of cases) expect(store.nextUnconfirmed(boundary, after, projection)?.operationId ?? null).toBe(expected)
  database.prepare("UPDATE connector_publication_operation SET state='dispatching' WHERE operation_id='first'").run()
  database.prepare("UPDATE connector_publication_operation SET state='unknown' WHERE operation_id='second'").run()
  expect(store.nextUnconfirmed(boundary)?.operationId).toBe('first')
  expect(store.nextUnconfirmed(boundary, 'first')?.operationId).toBe('second')
  recoveryCostFacts.push({ case: 'scope-order-projection', cases, swappedStates: ['first', 'second'] })
})

it('recent delivery ordering follows scoped original ordinals through SDK and compiled CLI while diagnosis retains independent unknown effects', async () => {
  const f = await fixture(async request => JSON.parse(request.request.body!).text === 'Old unknown original'
    ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'confirmed', mapping: { messageId: 'native-' + request.requestKey } })
  await appendFile(f.transcript, Array.from({ length: 7 }, (_, i) => row('ordered-reply-' + i, i === 0 ? 'Old unknown original' : 'Original reply ' + i)).join(''))
  await vi.waitFor(() => expect(f.speech()).toHaveLength(7))
  await vi.waitFor(() => expect(f.speech().slice(1).every(op => op.state === 'confirmed')).toBe(true))
  const originalUnknown = structuredClone(f.speech()[0]!), originalEffects = f.dispatched.length
  expect(originalUnknown.state).toBe('unknown')
  const all = f.services.publication!.store.list(f.binding), ids = all.map(op => op.operationId), newest = [...ids].reverse()
  expect(all).toHaveLength(8)
  expect(f.speech().map(op => op.reference.source.kind === 'native' ? op.reference.source.recordId : null)).toEqual(Array.from({ length: 7 }, (_, i) => 'ordered-reply-' + i))
  const input = { connectionId: config.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision, limit: 3 }
  const first = await f.sdk.call('connection.delivery.ls', input)
  expect(first.deliveries.map(op => op.operationId)).toEqual(ids.slice(0, 3))
  expect(await f.sdk.call('connection.delivery.ls', { ...input, order: 'oldest' })).toEqual(first)
  const olderNext = await f.sdk.call('connection.delivery.ls', { ...input, after: first.next! })
  expect(olderNext.deliveries.map(op => op.operationId)).toEqual(ids.slice(3, 6))
  const latest = await f.sdk.call('connection.delivery.ls', { ...input, order: 'newest' })
  expect(latest.deliveries.map(op => op.operationId), 'Newest-first public delivery returns the last original operation rather than walking old history').toEqual(newest.slice(0, 3))
  const latestNext = await f.sdk.call('connection.delivery.ls', { ...input, order: 'newest', after: latest.next! })
  expect(latestNext.deliveries.map(op => op.operationId)).toEqual(newest.slice(3, 6))
  expect((await f.sdk.call('connection.delivery.ls', { ...input, order: 'newest', after: latestNext.next! })).deliveries.map(op => op.operationId)).toEqual(newest.slice(6))
  const args = ['ls', '--connection', config.connectionId, '--binding', f.binding.bindingId, '--binding-revision', String(f.binding.revision), '--limit', '3']
  expect((await f.cli(args)).deliveries.map((op: { operationId: string }) => op.operationId)).toEqual(ids.slice(0, 3))
  expect((await f.cli([...args, '--order', 'newest'])).deliveries.map((op: { operationId: string }) => op.operationId)).toEqual(newest.slice(0, 3))
  expect((await f.cli([...args, '--order', 'newest', '--after', latest.next!])).deliveries.map((op: { operationId: string }) => op.operationId)).toEqual(newest.slice(3, 6))
  for (const order of ['sideways', '', 1, null]) await expect(f.sdk.call('connection.delivery.ls', { ...input, order } as never)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_DELIVERY_DATA' })

  const changes = vi.spyOn(f.conversation, 'changes').mockRejectedValue(new AgentMuxError('Controlled original source gap', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'))
  f.services.publication!.refresh()
  await vi.waitFor(async () => expect((await f.services.publication!.list(input)).sourceObservation?.state).toBe('unavailable'))
  const report = await f.sdk.call('connection.diagnose', { executionHostId: 'local', agentSessionId: f.session.agentSessionId })
  const outgoing = report.groups.value!.items[0]!.outgoing.value!
  recentDeliveryFacts = { originalIds: ids, expectedRecent: newest.slice(0, 5), observedRecent: outgoing.deliveries.map(op => op.operationId),
    originalUnknown: { operationId: originalUnknown.operationId, state: originalUnknown.state }, effectObservation: outgoing.effectObservation, sourceObservation: outgoing.sourceObservation,
    originalEffects, effectsAfterRead: f.dispatched.length }
  expect(outgoing.deliveries.map(op => op.operationId), 'Diagnosis reads only the newest five original outgoing operations').toEqual(newest.slice(0, 5))
  expect(outgoing.deliveries.every(op => op.receipt === 'confirmed')).toBe(true)
  expect(outgoing.effectObservation).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
  expect(outgoing.sourceObservation).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const cliReport = await f.diagnose()
  recentDeliveryFacts = { ...(recentDeliveryFacts as Record<string, unknown>), sdkReport: report, cliReport }
  expect(cliReport.target).toEqual(report.target)
  expect(cliReport.groups.value!.items[0]!.outgoing.value).toEqual(outgoing)
  expect(f.services.publication!.store.inspect(originalUnknown.operationId)).toEqual(originalUnknown)
  expect(f.dispatched).toHaveLength(originalEffects)
  changes.mockRestore()

  const otherSession = { ...f.session, agentSessionId: 'ordered-other-agent', run: { runId: 'ordered-other-run' } }
  await f.store.compareAndSwap(null, otherSession)
  await f.change(graph => { graph.regions.find(region => region.regionId === 'other-region')!.agentSessionId = otherSession.agentSessionId })
  const other = await f.sdk.call('connection.bind', { ...f.input, operationId: 'ordered-other-binding', bindingId: 'ordered-other-binding', agentSessionId: otherSession.agentSessionId, regionAnchor: { regionId: 'other-region' }, externalConversationId: 'ordered-other-room' })
  expect(other.state, JSON.stringify(other)).toBe('applied')
  await expect(f.sdk.call('connection.delivery.ls', { ...input, bindingId: 'ordered-other-binding', after: latest.next!, order: 'newest' })).rejects.toMatchObject({ code: 'INVALID_PUBLICATION_REQUEST' })
  const revised = await f.sdk.call('connection.binding.relink', { ...f.input, operationId: 'ordered-new-revision', expectedRevision: 1 })
  expect(revised.state).toBe('applied')
  await expect(f.sdk.call('connection.delivery.ls', { ...input, bindingRevision: 2, after: latest.next!, order: 'newest' })).rejects.toMatchObject({ code: 'INVALID_PUBLICATION_REQUEST' })
  expect((await f.sdk.call('connection.delivery.ls', { ...input, limit: 100, order: 'newest' })).deliveries.map(op => op.operationId)).toEqual(newest)
  await expect(f.sdk.call('connection.delivery.ls', { ...input, connectionId: 'foreign-connection' })).rejects.toMatchObject({ code: 'PUBLICATION_SOURCE_CONFLICT' })
  const plans = f.services.database!.prepare('EXPLAIN QUERY PLAN SELECT operation_json,state FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?').all(f.binding.bindingId, f.binding.revision, Number.MAX_SAFE_INTEGER, 3)
  expect(plans.some(plan => /SEARCH.*connector_publication_audit/.test(String(plan.detail)))).toBe(true)
  expect(plans.some(plan => /SCAN|TEMP B-TREE/.test(String(plan.detail)))).toBe(false)
  expect(f.services.publication!.store.inspect(originalUnknown.operationId)).toEqual(originalUnknown)
  expect(f.dispatched.filter(effect => effect.request.requestKey === originalUnknown.operationId)).toHaveLength(1)
}, 35_000)

it.each([
  ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'],
  ['AGENT_SESSION_HISTORY_BUSY', 'AGENT_SESSION_HISTORY_BUSY'],
  ['AGENT_SESSION_HISTORY_BUDGET', 'AGENT_SESSION_HISTORY_BUDGET'],
  ['AGENT_CONVERSATION_VIEW_EXPIRED', 'AGENT_CONVERSATION_VIEW_EXPIRED'],
  ['AGENT_CONVERSATION_WINDOW_FULL', 'AGENT_CONVERSATION_WINDOW_FULL'],
  ['PRIVATE_UNKNOWN_READER_CODE', null]
] as const)('publication source failure %s remains distinct from old unknown effects through SDK, CLI and diagnosis export', async (code, admittedCode) => {
  const f = await fixture(async () => ({ state: 'unknown', reason: 'effect-unconfirmed' }))
  const target = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  await appendFile(f.transcript, row('original-unknown', 'Original public progress'))
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('unknown'))
  const original = structuredClone(f.speech()[0]!), dispatched = f.dispatched.length
  const before = await f.services.publication!.list({ connectionId: config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })
  const checkpoint = (await f.client.conversationCheckpoint(target)).checkpoint
  const reordered = { frontier: { cuts: checkpoint.frontier.cuts, scope: checkpoint.frontier.scope, agentSessionId: checkpoint.frontier.agentSessionId, hostId: checkpoint.frontier.hostId }, sourceHostId: checkpoint.sourceHostId, agentSessionId: checkpoint.agentSessionId, hostId: checkpoint.hostId }
  expect(connectionDiagnosisCheckpointKey(reordered)).toBe(connectionDiagnosisCheckpointKey(checkpoint))
  expect(before.sourceObservation?.state).toBe('ready')
  // The original read failure is controlled; the Host journal, public diagnosis,
  // strict SDK/CLI codecs and prior external effect remain their real owners.
  const changes = vi.spyOn(f.conversation, 'changes').mockRejectedValue(new AgentMuxError('PRIVATE source failure ' + f.root, code))
  f.services.publication!.refresh()
  await vi.waitFor(async () => expect((await f.services.publication!.list({ connectionId: config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })).sourceObservation?.state).toBe('unavailable'))
  const report = await f.sdk.call('connection.diagnose', { executionHostId: target.hostId, agentSessionId: target.agentSessionId }), group = report.groups.value!.items[0]!, outgoing = group.outgoing.value!
  expect(outgoing).toMatchObject({ observation: { state: 'unavailable', reason: 'source-gap' }, sourceObservation: { state: 'unavailable', reason: 'source-gap', code: admittedCode, codeRecorded: true, checkpointKey: before.sourceObservation!.checkpointKey }, effectObservation: { state: 'unknown', reason: 'effect-unconfirmed' } })
  expect(outgoing.deliveries.find(delivery => delivery.operationId === original.operationId)).toMatchObject({ receipt: 'unknown', association: { recordKey: connectionDiagnosisRecordKey(original.reference as any), eventKey: connectionDiagnosisEventKey(original.reference as any, original.event!) } })
  expect(await f.diagnose()).toEqual(report)
  const exported = formatGroupDiagnosis({ ...group, service: report.service })
  expect(exported).toContain('Source read: unavailable · source-gap')
  if (admittedCode) expect(exported).toContain('code ' + admittedCode)
  expect(exported).toContain('Unresolved effects: unknown · effect-unconfirmed')
  expect(JSON.stringify(report) + exported).not.toMatch(/PRIVATE|original-native|Original public progress|original-unknown/)
  expect(JSON.stringify(report) + exported).not.toContain(f.root)
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched).toHaveLength(dispatched)
  const read = core.consumeConversationWindowPage(await f.client.readAgentConversation({ ...target, record: original.reference as any }))
  expect(read.kind).toBe('complete')
  if (read.kind !== 'complete') throw new Error('The controlled original record must be completely read.')
  expect(read.snapshot.units.flatMap(unit => unit.records).some(record => record.reference && connectionDiagnosisRecordKey(record.reference) === outgoing.deliveries.find(delivery => delivery.operationId === original.operationId)!.association.recordKey)).toBe(true)
  changes.mockRestore(); f.services.publication!.refresh()
  await vi.waitFor(async () => expect((await f.services.publication!.list({ connectionId: config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })).sourceObservation?.state).toBe('ready'))
  // Current reader success leaves the original unknown receipt and durable identity unchanged.
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original); expect(f.dispatched).toHaveLength(dispatched)
  const human = JSON.stringify({ sessionId: 'original-native', uuid: 'local-unshared-input', type: 'user', message: { role: 'user', content: 'PRIVATE local input' } }) + '\n'
  await appendFile(f.transcript, human)
  await vi.waitFor(async () => {
    const page = await f.client.readAgentConversation({ ...target, record: { ...target, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'local-unshared-input' } } })
    expect(core.consumeConversationWindowPage(page).kind).toBe('complete')
    expect(page.items.length).toBeGreaterThan(0)
  })
  f.services.publication!.refresh()
  await vi.waitFor(async () => expect((await f.services.publication!.list({ connectionId: config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })).sourceObservation?.checkpointKey).not.toBe(before.sourceObservation!.checkpointKey))
  expect(f.speech()).toHaveLength(1); expect(f.dispatched).toHaveLength(dispatched)
  expect(f.client.connect).not.toHaveBeenCalled()
  wireBudgetFacts.push({ case: 'safe-source-code', sourceCode: code, admittedCode, codeRecorded: true,
    originalEffectOperation: original.operationId, originalCheckpointKey: before.sourceObservation!.checkpointKey,
    originalUnknownRetained: true, nativeDispatches: dispatched, strictRpcAndCompiledCliMatched: true,
    boundary: 'Controlled original reader exception; real PublicationHost, durable source/effect journal and public diagnosis/SDK/compiled CLI.' })
}, 30_000)

it('publication wire budget continues the original oversized coverage window without replaying an unknown effect', async () => {
  const unknownText = 'Original publication effect remains unconfirmed'
  const f = await fixture(async request => JSON.parse(request.request.body!).text === unknownText
    ? { state: 'unknown', reason: 'effect-unconfirmed' }
    : { state: 'confirmed', mapping: { messageId: 'message-' + request.requestKey } }, false, undefined, { retired: false })
  const reference = { hostId: 'local', agentSessionId: f.session.agentSessionId }, metadata = await f.store.readMetadata(f.session.agentSessionId)
  expect(metadata).toMatchObject({ agentSessionId: f.session.agentSessionId, run: f.session.run })
  const binding = structuredClone(f.binding)
  await appendFile(f.transcript, row('budget-original-unknown', unknownText))
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('unknown'))
  const unknown = structuredClone(f.speech()[0]!), retained = structuredClone(f.services.publication!.store.retainedCheckpoint(binding)!)
  expect(retained).toBeDefined()
  const retainedBytes = JSON.stringify(retained), initialPosts = f.dispatched.length
  f.services.publication!.close()

  // These are original, typed captured observations with unread canonical refs.
  // The real projector produces their honest gaps; no success page or gap result
  // is mocked. Each source identity remains below the unchanged public codec cap.
  for (let index = 0; index < 12; index++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: reference.agentSessionId, item: {
    id: 'budget-observation-' + index, agentSessionId: reference.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete',
    title: 'Original observation', content: 'Observation only', createdAt: 1000 + index, updatedAt: 1000 + index,
    conversation: { sameEvent: { ...reference, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'unread-original-' + index + '-' + 'r'.repeat(6000) } } }
  } })
  const progressText = 'Original progress 中🙂\n'.repeat(1500), finalText = 'Original final 中🙂\n'.repeat(1700)
  const nativeRow = (id: string, text: string, stop_reason: 'tool_use' | 'end_turn') => JSON.stringify({ sessionId: 'original-native', uuid: id,
    type: 'assistant', message: { role: 'assistant', stop_reason, content: [{ type: 'text', text }] } }) + '\n'
  await appendFile(f.transcript, nativeRow('budget-progress', progressText, 'tool_use') + nativeRow('budget-final', finalText, 'end_turn'))
  const request = { ...reference, checkpoint: retained, limit: 100 }
  await expect(f.sdk.call('agent.conversation.changes', request)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUDGET' })

  // Independently consume a bounded fragmented public window. Its envelope alone
  // exceeds the default budget even when all event bodies are excluded.
  let cursor: string | undefined, pending: core.ConversationWindowAssembly | undefined, snapshot: core.ConversationWindowSnapshot | undefined
  const pageBytes: number[] = [], envelopeBytes: number[] = []
  let fragments = 0
  for (let reads = 0; reads < 40; reads++) {
    const page = await f.sdk.call('agent.conversation.changes', { ...request, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) })
    const bytes = Buffer.byteLength(JSON.stringify(page))
    pageBytes.push(bytes); envelopeBytes.push(Buffer.byteLength(JSON.stringify({ ...page, items: [] })))
    expect(bytes).toBeLessThanOrEqual(128 * 1024)
    fragments += page.items.filter(item => item.kind === 'fragment').length
    const assembled = core.consumeConversationWindowPage(page, pending)
    if (assembled.kind === 'complete') { snapshot = assembled.snapshot; break }
    pending = assembled.pending; expect(page.nextCursor).toBeTruthy(); expect(page.nextCursor).not.toBe(cursor); cursor = page.nextCursor!
  }
  expect(snapshot, 'The complete original window must assemble through real public fragments').toBeDefined()
  expect(Math.min(...envelopeBytes)).toBeGreaterThan(64 * 1024)
  expect(fragments).toBeGreaterThan(0)
  const readRecords = snapshot!.units.flatMap(unit => unit.records).filter(core.isCompleteConversationRecord)
  for (const [id, text, phase] of [['budget-progress', progressText, 'progress'], ['budget-final', finalText, 'final']] as const)
    expect(readRecords.find(record => record.original.kind === 'native' && record.original.item.id === id)?.original)
      .toMatchObject({ kind: 'native', item: { messagePhase: phase, contentParts: [{ kind: 'text', text }] } })
  expect(snapshot!.coverage.flatMap(source => source.gaps)).toHaveLength(12)

  const { PublicationHost } = await import('../src/publication-host.js')
  const connections = new ConnectionHost({ database: f.services.database!, secrets: { resolve: async () => 'original-private-credential' },
    adapters: [{ adapterId: 'sample', publication: f.adapter, test: async () => ({ authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }) }] })
  const resumed = new PublicationHost({ connections, bindings: f.services.bindings!, conversation: f.conversation })
  cleanup.push(() => resumed.close()); f.services.connections.delivery = resumed
  await vi.waitFor(() => {
    for (const id of ['budget-progress', 'budget-final']) {
      const records = f.speech().filter(operation => operation.reference.source.recordId === id)
      expect(records.length, 'Missing original native output: ' + id).toBeGreaterThan(0)
      expect(records.map(operation => ({ state: operation.state, receipt: operation.receipt }))).toEqual(records.map(() => expect.objectContaining({ state: 'confirmed' })))
    }
  }, { timeout: 8000 })
  for (const [id, text, phase] of [['budget-progress', progressText, 'progress'], ['budget-final', finalText, 'final']] as const) {
    const records = f.speech().filter(operation => operation.reference.source.recordId === id).sort((a, b) => a.fragment.ordinal - b.fragment.ordinal)
    expect(records.length).toBeGreaterThan(1)
    expect(records.every(operation => operation.payload.kind === 'speech' && operation.payload.phase === phase && operation.reference.source.kind === 'native')).toBe(true)
    expect(records.map(operation => operation.payload.kind === 'speech' ? operation.payload.text : '').join('')).toBe(text)
    for (const operation of records) {
      expect(f.dispatched.filter(value => value.request.requestKey === operation.operationId)).toHaveLength(1)
      const receipt = await f.sdk.call('connection.delivery.inspect', { operationId: operation.operationId })
      expect(receipt.delivery).toMatchObject({ operationId: operation.operationId, state: 'confirmed', reference: operation.reference, fragment: operation.fragment })
    }
  }
  expect(f.speech().every(operation => ['budget-original-unknown', 'budget-progress', 'budget-final'].includes(operation.reference.source.recordId))).toBe(true)
  const list = { connectionId: config.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision }
  const sdk = await f.sdk.call('connection.delivery.ls', list)
  expect(await f.cli(['ls', '--connection', config.connectionId, '--binding', binding.bindingId, '--binding-revision', String(binding.revision)])).toEqual(sdk)
  expect(sdk.sourceObservation?.state).toBe('ready'); expect(sdk.effectObservation).toMatchObject({ state: 'unknown', reason: 'effect-unconfirmed' })
  const published = f.dispatched.length, continued = resumed.store.retainedCheckpoint(binding)!
  resumed.refresh()
  await vi.waitFor(async () => expect((await resumed.list(list)).sourceObservation?.state).toBe('ready'))
  expect(f.dispatched).toHaveLength(published)
  expect(resumed.store.inspect(unknown.operationId)).toEqual(unknown)
  expect(f.dispatched.filter(value => value.request.requestKey === unknown.operationId)).toHaveLength(1)
  expect(JSON.stringify(retained)).toBe(retainedBytes); expect(continued).not.toEqual(retained)
  expect((await f.services.bindings!.list({ connectionId: config.connectionId })).bindings[0]).toEqual(binding)
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(metadata); expect(f.client.connect).not.toHaveBeenCalled()
  wireBudgetFacts.push({ case: 'oversized-coverage', defaultFailure: 'AGENT_SESSION_HISTORY_BUDGET', envelopeBytes, pageBytes, fragments,
    gapCount: snapshot!.coverage.flatMap(source => source.gaps).length, phases: ['progress', 'final'], originalBindingUnchanged: true,
    originalCheckpointUnedited: true, originalUnknownOperation: unknown.operationId, initialPosts, publishedPosts: published,
    strictRpcAndCompiledCliMatched: true, runtimeConnectionCalls: 0,
    boundary: 'Real Claude protocol bytes and typed captured observations generate the large envelope through the real Core reader; actual Host/Store/Outbox with controlled external adapter receipts. No live root-cause or platform delivery claim.' })
}, 30_000)

it('original Desktop Host automatically publishes shared Core source changes, retaining exact records through compiled CLI inspection', async () => {
  const f = await fixture(), originalMetadata = await readFile(f.storePath)
  await appendFile(f.transcript, row('reply-a') + row('reply-b'))
  await vi.waitFor(() => expect(f.dispatched).toHaveLength(2), { timeout: 5_000 })
  const operations = f.speech()
  expect(operations.map(operation => operation.reference.source.recordId)).toEqual(['reply-a', 'reply-b'])
  expect(operations.every(operation => operation.state === 'confirmed')).toBe(true)
  expect(f.dispatched.map(value => JSON.parse(value.request.request.body!).text)).toEqual(['Same original reply', 'Same original reply'])
  expect(new Set(f.dispatched.map(value => value.request.requestKey)).size).toBe(2)
  expect(f.dispatched.every(value => value.target.externalConversationId === f.input.externalConversationId)).toBe(true)
  const listed = await f.cli(['ls', '--connection', config.connectionId, '--binding', f.binding.bindingId, '--binding-revision', '1'])
  expect(listed.deliveries.filter((operation: { reference: { source: { kind: string } } }) => operation.reference.source.kind !== 'binding-operation').map((operation: { operationId: string }) => operation.operationId)).toEqual(operations.map(operation => operation.operationId))
  const inspected = await f.cli(['inspect', '--operation-id', operations[0]!.operationId])
  expect(inspected.delivery).toMatchObject({ operationId: operations[0]!.operationId, reference: operations[0]!.reference, receipt: operations[0]!.receipt })
  expect(JSON.stringify(inspected)).not.toMatch(/original-private-credential|prepared|Same original reply|body/)
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, 1).state).toBe('ready'))
  expect(f.dispatched).toHaveLength(2)
  expect(await readFile(f.storePath)).toEqual(originalMetadata)
  expect(f.client.connect).not.toHaveBeenCalled()
}, 20_000)

it('unknown original effects retain their identity across worker replacement while independent speech continues', async () => {
  const f = await fixture(async request => JSON.parse(request.request.body!).text === 'Unconfirmed first reply'
    ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'confirmed', mapping: { messageId: 'independent-platform-message' } })
  await appendFile(f.transcript, row('reply-a', 'Unconfirmed first reply') + row('reply-b', 'Independent reply'))
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('unknown'), { timeout: 5_000 })
  await vi.waitFor(() => expect(f.speech()[1]?.state).toBe('confirmed'))
  expect(f.dispatched).toHaveLength(2)
  const original = f.speech()[0]!
  f.services.publication!.close()
  const { PublicationHost } = await import('../src/publication-host.js')
  // Reuse the original database/configuration owner; replacement admits no external effect for an unresolved operation.
  const connections = new ConnectionHost({ database: f.services.database!, secrets: { resolve: async () => 'original-private-credential' },
    adapters: [{ adapterId: 'sample', publication: f.adapter, test: async () => ({ authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }) }] })
  const restored = new PublicationHost({ connections, bindings: f.services.bindings!, conversation: f.conversation }); cleanup.push(() => restored.close())
  await vi.waitFor(() => expect(restored.observation(f.binding.bindingId, 1)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' }))
  expect(restored.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched).toHaveLength(2)
  await expect(restored.retry({ operationId: original.operationId }, { actor: { kind: 'user', id: 'original-user' } })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  expect(restored.store.list(f.binding).filter(operation => operation.reference.source.kind !== 'binding-operation')[1]?.state).toBe('confirmed')
}, 15_000)

it('a single slow inspector never gates independent speech, and its late original receipt releases only the dependent update', async () => {
  const f = await fixture(async (request, _target, _credential, _signal, mapping) => JSON.parse(request.request.body!).text === 'Original uncertain progress'
    ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'confirmed', mapping: mapping ?? { messageId: 'independent-message-' + request.requestKey } })
  let finish!: (value: PublicationReceipt | null) => void
  const inspector = vi.fn(async () => await new Promise<PublicationReceipt | null>(resolve => { finish = resolve }))
  f.adapter.inspect = inspector
  await appendFile(f.transcript, row('unknown-progress', 'Original uncertain progress'))
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('unknown'))
  const original = f.speech()[0]!, frozen = structuredClone(original.prepared)
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(inspector).toHaveBeenCalledOnce())
  await appendFile(f.transcript, row('unknown-progress', 'Dependent progress update') + row('independent-final', 'Independent public final'))
  await vi.waitFor(() => expect(f.dispatched.some(item => JSON.parse(item.request.request.body!).text === 'Independent public final')).toBe(true))
  for (let repeat = 0; repeat < 4; repeat++) { f.services.publication!.refresh(); await new Promise<void>(resolve => setImmediate(resolve)) }
  expect(inspector).toHaveBeenCalledOnce()
  expect(f.dispatched.some(item => JSON.parse(item.request.request.body!).text === 'Dependent progress update')).toBe(false)
  expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'unknown', attempt: 1, prepared: frozen })
  expect(f.services.publication!.observation(f.binding.bindingId, 1)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
  finish({ state: 'confirmed', mapping: { messageId: 'original-progress-message', threadId: 'original-progress-thread' } })
  await vi.waitFor(() => expect(f.dispatched.some(item => JSON.parse(item.request.request.body!).text === 'Dependent progress update')).toBe(true))
  const update = f.dispatched.find(item => JSON.parse(item.request.request.body!).text === 'Dependent progress update')!
  expect(update.mapping).toEqual({ messageId: 'original-progress-message', threadId: 'original-progress-thread' })
  expect(f.services.publication!.store.inspect(original.operationId)?.prepared).toEqual(frozen)
  expect(f.dispatched.filter(item => item.request.requestKey === original.operationId)).toHaveLength(1)
  expect(f.client.connect).not.toHaveBeenCalled()
}, 15_000)

it('more than one drain of old unknown projections cannot starve later independent speech or spin unchanged inspections', async () => {
  const f = await fixture(async request => JSON.parse(request.request.body!).text.startsWith('Old uncertain')
    ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'confirmed', mapping: { messageId: 'fresh-' + request.requestKey } })
  const inspect = vi.fn(async () => null); f.adapter.inspect = inspect
  await appendFile(f.transcript, Array.from({ length: 20 }, (_, index) => row('unknown-' + index, 'Old uncertain ' + index)).join(''))
  await vi.waitFor(() => expect(f.speech().filter(operation => operation.state === 'unknown')).toHaveLength(20))
  await appendFile(f.transcript, row('fresh-final', 'Fresh independent final'))
  await vi.waitFor(() => expect(f.speech().find(operation => operation.reference.source.recordId === 'fresh-final')?.state).toBe('confirmed'))
  await new Promise<void>(resolve => setImmediate(resolve))
  const count = inspect.mock.calls.length
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(inspect).toHaveBeenCalledTimes(count)
  for (let repeat = 0; repeat < 20; repeat++) {
    const before = inspect.mock.calls.length
    f.services.publication!.refresh()
    await vi.waitFor(() => expect(inspect.mock.calls.length).toBeGreaterThan(before))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const inspected = vi.mocked(f.adapter.inspect!).mock.calls.map(call => call[0].requestKey)
  expect(new Set(inspected).size).toBe(20)
  expect(f.dispatched).toHaveLength(21)
  expect(f.services.publication!.observation(f.binding.bindingId, 1)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
}, 15_000)

it('an unknown original fragment retains same-projection order while another original message is delivered', async () => {
  const f = await fixture(async request => JSON.parse(request.request.body!).text.startsWith('First original fragment')
    ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'confirmed', mapping: { messageId: request.requestKey } })
  await appendFile(f.transcript, row('fragmented-original', 'First original fragment ' + 'x'.repeat(9000)) + row('independent-beside-fragments', 'Independent beside fragments'))
  await vi.waitFor(() => expect(f.speech().find(op => op.reference.source.recordId === 'independent-beside-fragments')?.state).toBe('confirmed'))
  const fragments = f.speech().filter(op => op.reference.source.recordId === 'fragmented-original')
  expect(fragments.map(op => op.state)).toEqual(['unknown', 'pending'])
  expect(fragments[1]?.predecessorOperationId).toBeUndefined()
  expect(f.dispatched).toHaveLength(2)
}, 15_000)

it('a read that ignores abort releases its observation slot and a genuinely late receipt still settles only its original attempt', async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal), deadlines: AbortController[] = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(duration => {
    if (duration !== 30_000) return originalTimeout(duration)
    const deadline = new AbortController(); deadlines.push(deadline); return deadline.signal
  })
  const f = await fixture(async () => ({ state: 'unknown', reason: 'effect-unconfirmed' }))
  let finishFirst!: (receipt: PublicationReceipt) => void
  const inspect = vi.fn<NonNullable<PublicationAdapter['inspect']>>(async request => inspect.mock.calls.length === 1
    ? await new Promise(resolve => { finishFirst = resolve }) : request.requestKey === f.speech()[1]?.operationId ? { state: 'confirmed', mapping: { messageId: 'read-' + request.requestKey } } : null)
  f.adapter.inspect = inspect
  await appendFile(f.transcript, row('unknown-first', 'First unknown') + row('unknown-second', 'Second unknown'))
  await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce())
  const [first, second] = f.speech(), frozen = structuredClone(first!.prepared)
  deadlines.at(-1)!.abort()
  await new Promise<void>(resolve => setImmediate(resolve))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(2))
  expect(inspect.mock.calls[1]![0].requestKey).toBe(second!.operationId)
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(second!.operationId)?.state).toBe('confirmed'))
  expect(f.services.publication!.store.inspect(first!.operationId)?.state).toBe('unknown')
  finishFirst({ state: 'confirmed', mapping: { messageId: 'late-original-message' } })
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(first!.operationId)?.state).toBe('confirmed'))
  expect(f.services.publication!.store.inspect(first!.operationId)).toMatchObject({ attempt: 1, prepared: frozen, mapping: { messageId: 'late-original-message' } })
  expect(f.dispatched).toHaveLength(2)
}, 15_000)

it('a concurrent original claim cannot switch the Host to an unqualified independent candidate', async () => {
  const qualified = new Set<string>()
  const f = await fixture(async request => {
    expect(qualified.has(request.requestKey), 'the effect must belong to the exact qualified operation').toBe(true)
    return { state: 'confirmed', mapping: { messageId: 'native-' + request.requestKey } }
  })
  const store = f.services.publication!.store, qualify = store.qualifyPending.bind(store)
  let competed = false
  vi.spyOn(store, 'qualifyPending').mockImplementation((...args) => {
    const result = qualify(...args)
    if (result === 'qualified') qualified.add(args[1].operationId)
    if (!competed && result === 'qualified') {
      competed = true
      const claimed = store.claimNext(f.binding, args[1].operationId, () => true, f.adapter)!
      store.settle(claimed.operationId, claimed.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
    }
    return result
  })
  await appendFile(f.transcript, row('concurrent-first', 'Original competitor') + row('qualified-next', 'Qualified independent record'))
  await vi.waitFor(() => expect(competed).toBe(true))
  await vi.waitFor(() => expect(store.list(f.binding).filter(operation => operation.reference.source.kind !== 'binding-operation').find(operation => operation.reference.source.recordId === 'qualified-next')?.state).toBe('confirmed'))
  expect(f.dispatched).toHaveLength(1)
  expect(JSON.parse(f.dispatched[0]!.request.request.body!).text).toBe('Qualified independent record')
}, 15_000)

it('source replacement exposes a retained source gap without adopting a new cut or mutating the original Agent', async () => {
  const f = await fixture(), original = f.services.publication!.store.checkpoint(f.binding, 'local'), metadata = await readFile(f.storePath)
  await rename(f.transcript, join(f.root, 'retained-source.jsonl'))
  await writeFile(f.transcript, row('replacement-speech'))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, 1)).toEqual({ state: 'unavailable', reason: 'content-unconfirmed' }), { timeout: 5_000 })
  expect(f.services.publication!.store.coverage(f.binding)).toMatchObject({ state: 'incomplete', gaps: [expect.objectContaining({ reason: 'source-gap' })] })
  expect(f.services.publication!.store.checkpoint(f.binding, 'local')).toEqual(original)
  expect(f.dispatched).toEqual([])
  expect(await readFile(f.storePath)).toEqual(metadata)
  expect(f.client.connect).not.toHaveBeenCalled()
}, 15_000)

it('publishes complete original resource-backed text and never includes internal reasoning or tool parts', async () => {
  const f = await fixture(), text = 'Complete original Unicode speech 中文🙂'.repeat(8_000)
  await appendFile(f.transcript, row('large-speech', '', [{ type: 'thinking', thinking: 'Private reasoning' }, { type: 'text', text }, { type: 'tool_use', id: 'tool-a', name: 'internal', input: { private: true } }]))
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding, 100).length).toBeGreaterThan(20), { timeout: 8_000 })
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding, 100).every(operation => operation.state === 'confirmed')).toBe(true), { timeout: 8_000 })
  const actual = f.dispatched.map(value => JSON.parse(value.request.request.body!).text).join('')
  expect(actual).toBe(text)
  expect(actual).not.toContain('Private reasoning')
  expect(f.dispatched.every(value => value.request.request.method === 'POST')).toBe(true)
}, 25_000)

it('a late first dispatch cannot certify a later same-ID retry as not-applied', async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal), deadlines: AbortController[] = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(duration => {
    if (duration !== 30_000) return originalTimeout(duration)
    const deadline = new AbortController(); deadlines.push(deadline); return deadline.signal
  })
  let finishFirst!: (receipt: PublicationReceipt) => void, calls = 0
  const f = await fixture(async () => {
    calls++
    if (calls === 1) return await new Promise(resolve => { finishFirst = resolve })
    return await new Promise(() => {})
  })
  const dispatchDeadline = deadlines.length
  await appendFile(f.transcript, row('retry-speech'))
  await vi.waitFor(() => expect(f.dispatched).toHaveLength(1))
  deadlines[dispatchDeadline]!.abort()
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('unknown'))
  f.adapter.inspect = async () => ({ state: 'not-applied', reason: 'platform-rejected' })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('not-applied'))
  f.adapter.inspect = async () => null
  const original = f.speech()[0]!
  await f.cli(['retry', '--operation-id', original.operationId])
  await vi.waitFor(() => expect(f.dispatched).toHaveLength(2))
  deadlines.at(-1)!.abort()
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)?.state).toBe('unknown'))
  finishFirst({ state: 'not-applied', reason: 'platform-rejected' })
  await new Promise(resolve => setImmediate(resolve))
  expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'unknown', attempt: original.attempt! + 1 })
  expect(f.dispatched[1]!.request).toEqual(f.dispatched[0]!.request)
  await expect(f.services.connections.delivery!.retry({ operationId: original.operationId }, { actor: { kind: 'user', id: 'original-user' } })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  expect(calls).toBe(2)
}, 15_000)

it('an unavailable authority read preserves the lane and reports unknown service rather than disabling the healthy Binding', async () => {
  const f = await fixture(), owner = f.services.publication!
  await vi.waitFor(() => expect(owner.observation(f.binding.bindingId, 1).state).toBe('ready'))
  const read = vi.spyOn(f.services.bindings!, 'publicationAuthority').mockImplementation(() => { throw new Error('private storage details') })
  owner.refresh()
  expect(owner.observation(f.binding.bindingId, 1)).toEqual({ state: 'unavailable', reason: 'storage-unconfirmed' })
  expect(f.dispatched).toEqual([])
  read.mockRestore()
  owner.refresh()
  await vi.waitFor(() => expect(owner.observation(f.binding.bindingId, 1).state).toBe('ready'))
  owner.close()
  await expect(owner.retry({ operationId: 'unknown-operation' }, { actor: { kind: 'user', id: 'original-user' } })).rejects.toMatchObject({ code: 'PUBLICATION_OWNER_UNAVAILABLE' })
  expect(f.client.connect).not.toHaveBeenCalled()
}, 15_000)

it('a slow Binding effect cannot occupy another Binding or the original Core reading lane', async () => {
  let finishSlow!: (receipt: PublicationReceipt) => void
  const f = await fixture(async (prepared, target) => target.externalConversationId === 'parallel-group'
    ? { state: 'confirmed', mapping: { messageId: 'parallel-message' } }
    : await new Promise(resolve => { finishSlow = resolve }))
  const saved = (await f.services.connections.inspect({ connectionId: config.connectionId })).connection!.config
  await f.services.connections.configure({ operationId: 'parallel-configure', expectedRevision: null, connection: {
    ...saved, connectionId: 'parallel-connection', application: { ...saved.application, appId: 'parallel-app' } } })
  const parallel = await f.services.connections.bindings!.bind({ ...f.input, operationId: 'parallel-bind', bindingId: 'parallel-binding',
    connectionId: 'parallel-connection', externalConversationId: 'parallel-group' }, { actor: { kind: 'user', id: 'original-user' } })
  expect(parallel.state).toBe('applied'); if (parallel.state !== 'applied') throw new Error('Parallel Binding was not applied.')
  await appendFile(f.transcript, row('parallel-speech'))
  await vi.waitFor(() => expect(f.services.publication!.store.list(parallel.binding).find(operation => operation.reference.source.recordId === 'parallel-speech')?.state).toBe('confirmed'), { timeout: 5_000 })
  expect(f.speech()[0]?.state).toBe('dispatching')
  const source = await f.client.readSessionHistoryChanges(f.binding.agentSessionId, { checkpoint: f.binding.sourceCheckpoints[0]! })
  expect(source.items.map(item => item.id)).toEqual(['parallel-speech'])
  expect(f.client.connect).not.toHaveBeenCalled()
  finishSlow({ state: 'confirmed', mapping: { messageId: 'slow-message' } })
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('confirmed'))
  expect(f.dispatched).toHaveLength(2)
}, 15_000)

it('closing while current human authorization is pending retains the original non-applied outcome', async () => {
  const f = await fixture(async () => ({ state: 'not-applied', reason: 'platform-rejected' }))
  await appendFile(f.transcript, row('original-not-applied'))
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('not-applied'))
  const original = f.speech()[0]!
  let approve!: () => void
  const current = new Promise<void>(resolve => { approve = resolve })
  const retry = f.services.publication!.retry({ operationId: original.operationId }, { actor: { kind: 'user', id: 'original-user' }, assertCurrent: () => current })
  f.services.publication!.close(); approve()
  await expect(retry).rejects.toMatchObject({ code: 'PUBLICATION_OWNER_UNAVAILABLE' })
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched).toHaveLength(1)
}, 15_000)

it('original worker passes durable message and thread mapping to update, inspect and withdrawal independently of wire bytes', async () => {
  const mapping = { messageId: 'original-platform-message', threadId: 'original-platform-thread' }
  const f = await fixture(async (request, _target, _credential, _signal, original) => {
    if (request.request.method === 'POST') { expect(original).toBeUndefined(); return { state: 'confirmed', mapping } }
    expect(original).toEqual(mapping)
    return request.request.method === 'DELETE' ? { state: 'confirmed', mapping: original! } : { state: 'unknown', reason: 'effect-unconfirmed' }
  })
  const metadata = await readFile(f.storePath), inspections: Array<Readonly<PublicationMapping> | undefined> = []
  let readable = false
  f.adapter.inspect = async (_request, _target, _credential, _signal, original) => {
    inspections.push(original)
    expect(original).toEqual(mapping)
    return readable ? { state: 'confirmed', mapping: original! } : null
  }
  await appendFile(f.transcript, row('mapped-speech', 'Original speech'))
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('confirmed'))
  await appendFile(f.transcript, row('mapped-speech', 'Updated speech'))
  await vi.waitFor(() => expect(f.speech()[1]?.state).toBe('unknown'))
  expect(f.dispatched[1]?.mapping).toEqual(mapping)
  await vi.waitFor(() => expect(inspections).toContainEqual(mapping))
  readable = true; f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.speech()[1]?.state).toBe('confirmed'))
  await appendFile(f.transcript, row('mapped-speech', '', [{ type: 'thinking', thinking: 'Retained private source' }]))
  await vi.waitFor(() => expect(f.speech()[2]?.state).toBe('confirmed'))
  expect(f.dispatched.map(value => value.request.request.method)).toEqual(['POST', 'PATCH', 'DELETE'])
  expect(f.dispatched[2]?.mapping).toEqual(mapping)
  const operation = f.speech()[2]!
  const publicReceipt = await f.cli(['inspect', '--operation-id', operation.operationId])
  expect(publicReceipt.delivery.mapping).toEqual(mapping)
  expect(await readFile(f.storePath)).toEqual(metadata)
  expect(f.client.connect).not.toHaveBeenCalled()
  const evidence = join('.bagakit', 'evidence', 'feishu-publication'); await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'mapping-call-chain.json'), JSON.stringify({
    scope: 'Original Desktop publication worker and Core native reader with controlled generic platform I/O; no live platform claim',
    dispatches: f.dispatched, inspections, publicCall: { method: 'connection.delivery.inspect', params: { operationId: operation.operationId }, result: publicReceipt },
    originalMapping: mapping, originalSourceAndSessionRetained: true
  }, null, 2) + '\n')
}, 20_000)

it('publishes future native speech for the exact authenticated Agent author of its own Binding', async () => {
  const f = await fixture(undefined, true)
  expect(f.binding.authorizedBy).toEqual({ kind: 'agent', id: f.input.agentSessionId })
  expect(f.services.bindings!.publicationAuthority(f.binding.bindingId, f.binding.revision).authorized).toBe(true)
  await appendFile(f.transcript, row('agent-owned-reply', 'Original Agent publication'))
  await vi.waitFor(() => expect(f.dispatched).toHaveLength(1), { timeout: 5_000 })
  expect(f.dispatched[0]!.target.externalConversationId).toBe(f.input.externalConversationId)
  expect(JSON.parse(f.dispatched[0]!.request.request.body!).text).toBe('Original Agent publication')
  expect(f.speech()).toEqual([expect.objectContaining({ state: 'confirmed', reference: expect.objectContaining({ source: expect.objectContaining({ recordId: 'agent-owned-reply' }) }) })])
}, 20_000)
