import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { connectAgentMuxRpc } from '../../core/src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { PublicationStore, publicDelivery, type PublicationBoundary } from '../src/publication-store.js'
import { ConnectionHost } from '../src/connection-host.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'
import { roomBindingFixture, config, core } from './fixtures/room-binding.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const shared = 'future-shared-conversation' as const
const original = 'future-native-user-facing' as const
const row = (id: string, type: 'assistant' | 'user') => JSON.stringify({ sessionId: 'original-native', uuid: id, type,
  message: { role: type, content: [{ type: 'text', text: 'Original content ' + id }] } }) + '\n'

/** Actual default Desktop composition, original Core reader, SQLite, RPC and compiled CLI.
 * Only the platform publication effect is a controlled leaf. No real group is contacted. */
async function fixture() {
  const f = await roomBindingFixture(); cleanup.push(f.close)
  const dispatch = vi.fn<PublicationAdapter['dispatch']>(async prepared => prepared.request.body === 'before-consent'
    ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'confirmed', mapping: { messageId: 'platform-' + prepared.requestKey } })
  const adapter: PublicationAdapter = { adapterId: 'sample', renderVersion: 'scope-fixture', supportedRenderVersions: ['scope-fixture'], fragmentBytes: 8192,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'scope-fixture', requestKey: operation.operationId,
      request: { method: 'POST', path: '/messages', body: operation.reference.source.recordId } }), dispatch }
  const services = await createDesktopConnections({ directory: join(f.root, 'sharing-host'),
    encryption: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() },
    adapters: [{ adapterId: 'sample', publication: adapter, test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }) }],
    bindings: { spatial: f.spatial, checkpoint: f.checkpoint }, publication: createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }]) })
  cleanup.push(services.close)
  const credential = await services.secrets.store({ operationId: 'sharing-credential', secret: 'private-scope-fixture' })
  await services.connections.configure({ operationId: 'sharing-config', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
  const path = join(f.root, 'sharing.sock'), server = new core.AgentMuxControlServer({ socketPath: path,
    connections: services.connections, spatialState: f.spatial, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => sdk.dispose())
  const cli = (args: string[], input?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + path, 'connection', ...args],
    objectCliEnvironment(f.root), input === undefined ? '' : JSON.stringify(input))
  return { ...f, services, dispatch, adapter, sdk, cli }
}
function result(value: { code: number; stdout: string; stderr: string }) {
  expect(value.code, value.stdout + value.stderr).toBe(0); return JSON.parse(value.stdout).result
}

it('public sharing consent keeps the old scope and unknown effect, then explicitly revises the same Binding at a fresh source cut', async () => {
  const f = await fixture(), metadata = await readFile(f.storePath), bound = result(await f.cli(['bind', '--input', '-'], f.input)).binding
  expect(bound.scope.publication).toBe(original)
  await appendFile(f.transcript, row('before-consent', 'assistant') + row('native-unknown-before', 'user'))
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1), { timeout: 5000 })
  const oldOperation = f.services.publication!.store.list(bound)[0]!
  expect(oldOperation).toMatchObject({ state: 'unknown', publicationScope: original })
  const replacement = { ...f.input, operationId: 'explicit-shared-consent', scope: { ...f.input.scope, publication: shared } }
  expect(result(await f.cli(['bind', '--input', '-'], { ...replacement, operationId: 'no-silent-expansion' })))
    .toMatchObject({ state: 'refused', code: 'ROOM_BINDING_MAPPING_CONFLICT' })
  expect((await f.sdk.call('connection.binding.inspect', { bindingId: bound.bindingId })).current).toEqual(bound)
  const cut = await f.client.conversationCheckpoint(f.input.agentSessionId)
  const relink = result(await f.cli(['binding', 'relink', '--input', '-'], { ...replacement, expectedRevision: 1 }))
  expect(relink).toMatchObject({ state: 'applied', binding: { bindingId: bound.bindingId, revision: 2, scope: { publication: shared }, sourceCheckpoints: [cut] } })
  expect(f.services.bindings!.publicationAuthority(bound.bindingId, 1).authorized).toBe(false)
  expect(f.services.bindings!.publicationAuthority(bound.bindingId, 2).authorized).toBe(true)
  await appendFile(f.transcript, row('after-consent', 'assistant'))
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(2), { timeout: 5000 })
  expect(f.dispatch.mock.calls.map(([request]) => request.request.body)).toEqual(['before-consent', 'after-consent'])
  const next = f.services.publication!.store.list(relink.binding)
  expect(next).toHaveLength(1); expect(next[0]).toMatchObject({ publicationScope: shared, bindingRevision: 2, state: 'confirmed' })
  expect(f.services.publication!.store.inspect(oldOperation.operationId)).toEqual(oldOperation)
  const inspected = result(await f.cli(['delivery', 'inspect', '--operation-id', oldOperation.operationId]))
  expect(inspected.delivery.state).toBe('unknown')
  expect(JSON.stringify(inspected)).not.toMatch(/publicationScope|private-scope-fixture|payload|prepared/)
  expect((await f.sdk.call('connection.binding.inspect', { bindingId: bound.bindingId, revision: 1 })).binding).toEqual(bound)
  expect(await readFile(f.storePath)).toEqual(metadata)
  expect(f.client.connect).not.toHaveBeenCalled()
}, 20000)

it('public codecs refuse coerced consent and actor forgery without changing an existing Binding', async () => {
  const f = await fixture(), bound = result(await f.cli(['bind', '--input', '-'], f.input)).binding
  for (const publication of [[shared], true, null, { value: shared }]) {
    const refused = await f.cli(['binding', 'relink', '--input', '-'], { ...f.input, operationId: 'invalid-consent', expectedRevision: 1,
      scope: { input: 'mentions-and-replies', publication } })
    expect(refused.code).not.toBe(0)
  }
  const forged = await f.cli(['binding', 'relink', '--input', '-'], { ...f.input, expectedRevision: 1, operationId: 'forged-consent',
    scope: { ...f.input.scope, publication: shared }, authorizedBy: { kind: 'user', id: 'untrusted' } })
  expect(forged.code).not.toBe(0)
  expect((await f.sdk.call('connection.binding.inspect', { bindingId: bound.bindingId })).current).toEqual(bound)
  expect(f.dispatch).not.toHaveBeenCalled(); await f.unchanged()
}, 20000)

it.each(['confirmed', 'unknown'] as const)('a shared native input gap stays visible beside a %s effect through compiled CLI and worker restart', async previousState => {
  const f = await fixture(), metadata = await readFile(f.storePath)
  const bound = result(await f.cli(['bind', '--input', '-'], { ...f.input, scope: { ...f.input.scope, publication: shared } })).binding
  await appendFile(f.transcript, row(previousState === 'unknown' ? 'before-consent' : 'qualified-assistant-speech', 'assistant'))
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1), { timeout: 5000 })
  const store = f.services.publication!.store, initial = bound.sourceCheckpoints[0], frontier = store.checkpoint(bound, initial)
  const originalEffect = store.list(bound)[0]!
  expect(originalEffect.state).toBe(previousState)
  await appendFile(f.transcript, row('unqualified-original-input', 'user') + row('later-speech', 'assistant'))
  await vi.waitFor(() => expect(f.services.publication!.observation(bound.bindingId, 1)).toEqual({ state: 'unavailable', reason: 'content-unconfirmed' }), { timeout: 5000 })
  const args = ['delivery', 'ls', '--connection', config.connectionId, '--binding', bound.bindingId, '--binding-revision', '1']
  expect(result(await f.cli(args)).observation).toEqual({ state: 'unavailable', reason: 'content-unconfirmed' })
  expect(result(await f.cli(['delivery', 'inspect', '--operation-id', originalEffect.operationId])).delivery.state).toBe(previousState)
  expect(store.checkpoint(bound, initial)).toEqual(frontier)
  expect(store.list(bound)).toHaveLength(1); expect(f.dispatch).toHaveBeenCalledTimes(1)
  f.services.publication!.close()
  const { PublicationHost } = await import('../src/publication-host.js')
  const connections = new ConnectionHost({ database: f.services.database!, secrets: { resolve: async () => 'private-scope-fixture' },
    adapters: [{ adapterId: 'sample', publication: f.adapter, test: async () => ({ authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }) }] })
  cleanup.push(() => connections.close())
  const restarted = new PublicationHost({ connections, bindings: f.services.bindings!,
    conversation: createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }]) })
  cleanup.push(() => restarted.close())
  await vi.waitFor(() => expect(restarted.observation(bound.bindingId, 1)).toEqual({ state: 'unavailable', reason: 'content-unconfirmed' }), { timeout: 5000 })
  expect(restarted.store.checkpoint(bound, initial)).toEqual(frontier); expect(f.dispatch).toHaveBeenCalledTimes(1)
  expect(await readFile(f.storePath)).toEqual(metadata); expect(f.client.connect).not.toHaveBeenCalled()
}, 20000)

it('a content gap keeps original effect inspection and already admitted pending delivery available', async () => {
  const f = await fixture(), bound = result(await f.cli(['bind', '--input', '-'], { ...f.input, scope: { ...f.input.scope, publication: shared } })).binding
  let confirmOriginal = false
  const inspect = vi.fn<NonNullable<PublicationAdapter['inspect']>>(async () => confirmOriginal ? { state: 'confirmed', mapping: { messageId: 'original-confirmed-platform-message' } } : null)
  f.adapter.inspect = inspect
  await appendFile(f.transcript, row('before-consent', 'assistant') + row('already-admitted-speech', 'assistant'))
  const store = f.services.publication!.store
  await vi.waitFor(() => expect(store.list(bound).map(operation => operation.state)).toEqual(['unknown', 'pending']), { timeout: 5000 })
  const [original, pending] = store.list(bound), initial = bound.sourceCheckpoints[0], frontier = store.checkpoint(bound, initial)
  await appendFile(f.transcript, row('unqualified-original-input', 'user') + row('later-unadmitted-speech', 'assistant'))
  const args = ['delivery', 'ls', '--connection', config.connectionId, '--binding', bound.bindingId, '--binding-revision', '1']
  await vi.waitFor(() => expect(f.services.publication!.observation(bound.bindingId, 1)).toEqual({ state: 'unavailable', reason: 'content-unconfirmed' }), { timeout: 5000 })
  expect(result(await f.cli(args)).observation).toEqual({ state: 'unavailable', reason: 'content-unconfirmed' })
  expect(store.inspect(original!.operationId)?.state).toBe('unknown')
  expect(f.dispatch).toHaveBeenCalledTimes(1)
  confirmOriginal = true; f.services.publication!.refresh()
  await vi.waitFor(() => expect(store.inspect(pending!.operationId)?.state).toBe('confirmed'), { timeout: 5000 })
  expect(inspect).toHaveBeenCalled()
  expect(f.dispatch.mock.calls.map(([prepared]) => prepared.request.body)).toEqual(['before-consent', 'already-admitted-speech'])
  expect(result(await f.cli(['delivery', 'inspect', '--operation-id', original!.operationId])).delivery).toMatchObject({ operationId: original!.operationId, state: 'confirmed' })
  expect(result(await f.cli(args)).observation).toEqual({ state: 'unavailable', reason: 'content-unconfirmed' })
  expect(store.checkpoint(bound, initial)).toEqual(frontier)
  expect(store.list(bound)).toHaveLength(2); expect(f.client.connect).not.toHaveBeenCalled()
}, 20000)

it('stored legacy pending work keeps its original scope instead of inheriting a broader claim', () => {
  const database = new DatabaseSync(':memory:'); cleanup.push(() => database.close())
  const store = new PublicationStore(database), checkpoint = { agentSessionId: 'agent', source: { providerId: 'claude', nativeSessionId: 'native' }, cursor: 'original-cut' }
  const boundary: PublicationBoundary = { bindingId: 'binding', revision: 1, connectionId: 'connection', application: config.application,
    executionHostId: 'local', agentSessionId: 'agent', externalConversationId: 'room', sourceCheckpoints: [checkpoint], scope: { input: 'mentions-and-replies', publication: original } }
  store.checkpoint(boundary, checkpoint)
  store.commitPage(boundary, checkpoint, { hostId: 'local', agentSessionId: 'agent', source: checkpoint.source,
    items: [{ id: 'reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Retained original speech' }] }], checkpoint: { ...checkpoint, cursor: 'after-reply' }, more: false }, () => true)
  const saved = store.list(boundary)[0]!, { publicationScope: _scope, ...legacy } = saved
  database.prepare('UPDATE connector_publication_operation SET operation_json=? WHERE operation_id=?').run(JSON.stringify(legacy), saved.operationId)
  const prepare = vi.fn(() => ({ adapterId: 'sample', renderVersion: 'fixture', requestKey: saved.operationId, request: { method: 'POST' as const, path: '/messages' } }))
  const adapter = { adapterId: 'sample', renderVersion: 'fixture', supportedRenderVersions: ['fixture'], prepare }
  expect(() => store.claimNext({ ...boundary, scope: { ...boundary.scope, publication: shared } }, () => true, adapter)).toThrowError(/original publication retains another sharing scope/)
  expect(prepare).not.toHaveBeenCalled(); expect(store.inspect(saved.operationId)).toEqual(legacy)
  expect(store.claimNext(boundary, () => true, adapter)?.operationId).toBe(saved.operationId)
  expect(publicDelivery(store.inspect(saved.operationId)!)).not.toHaveProperty('publicationScope')
})

it.each(['image', 'file'] as const)('broader sharing retains the original frontier when a complete %s cannot be delivered', kind => {
  const database = new DatabaseSync(':memory:'); cleanup.push(() => database.close())
  const store = new PublicationStore(database), checkpoint = { agentSessionId: 'agent', source: { providerId: 'claude', nativeSessionId: 'native' }, cursor: 'before-resource' }
  const boundary: PublicationBoundary = { bindingId: 'binding', revision: 1, connectionId: 'connection', application: config.application,
    executionHostId: 'local', agentSessionId: 'agent', externalConversationId: 'room', sourceCheckpoints: [checkpoint], scope: { input: 'mentions-and-replies', publication: shared } }
  store.checkpoint(boundary, checkpoint)
  expect(() => store.commitPage(boundary, checkpoint, { hostId: 'local', agentSessionId: 'agent', source: checkpoint.source,
    items: [{ id: 'original-resource-message', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original description' },
      { kind: 'resource', resourceType: kind, reference: 'original-opaque-read-reference' }] }], checkpoint: { ...checkpoint, cursor: 'after-resource' }, more: false }, () => true))
    .toThrowError(/complete resource delivery/)
  expect(store.checkpoint(boundary, checkpoint)).toEqual(checkpoint); expect(store.list(boundary)).toEqual([])
})
