import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { createConnectionServices } from '../src/connection-services.js'
import { ConnectionHost } from '../src/connection-host.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'
import type { PublicationReceipt, PublicationMapping } from '../src/publication-store.js'
import { PublicationStore } from '../src/publication-store.js'
import { config, roomBindingFixture, core } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { AgentMuxError } from '../../core/dist/errors.js'
import { connectAgentMuxRpc } from '../../core/dist/public-rpc-client.js'
import { connectionDiagnosisRecordKey, connectionDiagnosisEventKey, connectionDiagnosisCheckpointKey, formatGroupDiagnosis } from '../../core/dist/connections.js'

const cleanup: Array<() => void | Promise<void>> = []
let recentDeliveryFacts: unknown
const recoveryCostFacts: unknown[] = []
afterAll(async () => { if (process.env.AGENTMUX_TEST_DELIVERY_ORDER_FACTS) await writeFile(process.env.AGENTMUX_TEST_DELIVERY_ORDER_FACTS, JSON.stringify(recentDeliveryFacts ?? null, null, 2) + '\n') })
afterAll(async () => { if (process.env.AGENTMUX_TEST_PUBLICATION_RECOVERY_FACTS) await writeFile(process.env.AGENTMUX_TEST_PUBLICATION_RECOVERY_FACTS, JSON.stringify(recoveryCostFacts, null, 2) + '\n') })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const row = (id: string, text = 'Same original reply', content?: unknown[]) => JSON.stringify({ sessionId: 'original-native', uuid: id,
  type: 'assistant', message: { role: 'assistant', content: content ?? [{ type: 'text', text }] } }) + '\n'
async function fixture(effect?: PublicationAdapter['dispatch'], agentActor = false) {
  const original = await roomBindingFixture(); cleanup.push(() => original.close())
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
    bindings: { spatial: original.spatial, checkpoint: original.checkpoint }, publication: conversation })
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

it('publication source failures remain distinct from old unknown effects through SDK, CLI and diagnosis export', async () => {
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
  const changes = vi.spyOn(f.conversation, 'changes').mockRejectedValue(new AgentMuxError('PRIVATE source failure ' + f.root, 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'))
  f.services.publication!.refresh()
  await vi.waitFor(async () => expect((await f.services.publication!.list({ connectionId: config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })).sourceObservation?.state).toBe('unavailable'))
  const report = await f.sdk.call('connection.diagnose', { executionHostId: target.hostId, agentSessionId: target.agentSessionId }), group = report.groups.value!.items[0]!, outgoing = group.outgoing.value!
  expect(outgoing).toMatchObject({ observation: { state: 'unavailable', reason: 'source-gap' }, sourceObservation: { state: 'unavailable', reason: 'source-gap', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', codeRecorded: true, checkpointKey: before.sourceObservation!.checkpointKey }, effectObservation: { state: 'unknown', reason: 'effect-unconfirmed' } })
  expect(outgoing.deliveries.find(delivery => delivery.operationId === original.operationId)).toMatchObject({ receipt: 'unknown', association: { recordKey: connectionDiagnosisRecordKey(original.reference as any), eventKey: connectionDiagnosisEventKey(original.reference as any, original.event!) } })
  expect(await f.diagnose()).toEqual(report)
  const exported = formatGroupDiagnosis({ ...group, service: report.service })
  expect(exported).toContain('Source read: unavailable · source-gap · code AGENT_SESSION_HISTORY_SOURCE_CHANGED')
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
