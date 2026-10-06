import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { ConnectionHost } from '../src/connection-host.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'
import type { PublicationReceipt } from '../src/publication-store.js'
import { config, roomBindingFixture, core } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const row = (id: string, text = 'Same original reply', content?: unknown[]) => JSON.stringify({ sessionId: 'original-native', uuid: id,
  type: 'assistant', message: { role: 'assistant', content: content ?? [{ type: 'text', text }] } }) + '\n'
async function fixture(effect?: PublicationAdapter['dispatch']) {
  const original = await roomBindingFixture(); cleanup.push(() => original.close())
  const dispatched: Array<{ request: Parameters<PublicationAdapter['dispatch']>[0]; target: Parameters<PublicationAdapter['dispatch']>[1] }> = []
  const adapter: PublicationAdapter = { adapterId: 'sample', renderVersion: 'speech-v1', supportedRenderVersions: ['speech-v1'], fragmentBytes: 8_192,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'speech-v1', requestKey: operation.operationId,
      request: { method: operation.effect === 'withdraw' ? 'DELETE' : operation.mapping ? 'PATCH' : 'POST', path: '/messages', contentType: 'application/json',
        body: JSON.stringify({ room: operation.target.externalConversationId, text: operation.payload.text, mapping: operation.mapping }) } }),
    dispatch: async (request, target, credential, signal) => {
      expect(credential).toBe('original-private-credential')
      dispatched.push({ request: structuredClone(request), target: structuredClone(target) })
      return effect ? await effect(request, target, credential, signal) : { state: 'confirmed', mapping: JSON.parse(request.request.body!).mapping ?? { messageId: 'message-' + request.requestKey } }
    } }
  const conversation = createPublicationConversationPort(() => [{ hostId: 'local', client: original.client }])
  const services = await createDesktopConnections({ directory: join(original.root, 'desktop-publication'),
    encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    adapters: [{ adapterId: 'sample', publication: adapter, test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }],
    bindings: { spatial: original.spatial, checkpoint: original.checkpoint }, publication: conversation })
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'original-credential-entry', secret: 'original-private-credential' })
  await services.connections.configure({ operationId: 'original-configuration', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
  const binding = await services.connections.bindings!.bind(original.input, { actor: { kind: 'user', id: 'original-user' } })
  expect(binding.state).toBe('applied'); if (binding.state !== 'applied') throw new Error('Original fixture Binding not applied.')
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'publication.sock'), connections: services.connections, spatialState: original.spatial,
    coreClients: () => [{ hostId: 'local', client: original.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(original.root), cli = async (args: string[]) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + join(original.root, 'publication.sock'), 'connection', 'delivery', ...args], env)
    expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result
  }
  return { ...original, services, dispatched, adapter, conversation, binding: binding.binding, cli }
}

it('original Desktop Host automatically publishes shared Core source changes, retaining exact records through compiled CLI inspection', async () => {
  const f = await fixture(), originalMetadata = await readFile(f.storePath)
  await appendFile(f.transcript, row('reply-a') + row('reply-b'))
  await vi.waitFor(() => expect(f.dispatched).toHaveLength(2), { timeout: 5_000 })
  const operations = f.services.publication!.store.list(f.binding)
  expect(operations.map(operation => operation.reference.source.recordId)).toEqual(['reply-a', 'reply-b'])
  expect(operations.every(operation => operation.state === 'confirmed')).toBe(true)
  expect(f.dispatched.map(value => JSON.parse(value.request.request.body!).text)).toEqual(['Same original reply', 'Same original reply'])
  expect(new Set(f.dispatched.map(value => value.request.requestKey)).size).toBe(2)
  expect(f.dispatched.every(value => value.target.externalConversationId === f.input.externalConversationId)).toBe(true)
  const listed = await f.cli(['ls', '--connection', config.connectionId, '--binding', f.binding.bindingId, '--binding-revision', '1'])
  expect(listed.deliveries.map((operation: { operationId: string }) => operation.operationId)).toEqual(operations.map(operation => operation.operationId))
  const inspected = await f.cli(['inspect', '--operation-id', operations[0]!.operationId])
  expect(inspected.delivery).toMatchObject({ operationId: operations[0]!.operationId, reference: operations[0]!.reference, receipt: operations[0]!.receipt })
  expect(JSON.stringify(inspected)).not.toMatch(/original-private-credential|prepared|Same original reply|body/)
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, 1).state).toBe('ready'))
  expect(f.dispatched).toHaveLength(2)
  expect(await readFile(f.storePath)).toEqual(originalMetadata)
  expect(f.client.connect).not.toHaveBeenCalled()
}, 20_000)

it('unknown original effects remain inspect-only across worker replacement, with no overtaking, target fallback or new request key', async () => {
  const f = await fixture(async () => { throw new Error('private adapter transport failure') })
  await appendFile(f.transcript, row('reply-a') + row('reply-b'))
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding)[0]?.state).toBe('unknown'), { timeout: 5_000 })
  expect(f.dispatched).toHaveLength(1)
  const original = f.services.publication!.store.list(f.binding)[0]!
  f.services.publication!.close()
  const { PublicationHost } = await import('../src/publication-host.js')
  // Reuse the original database/configuration owner; replacement admits no external effect for an unresolved operation.
  const connections = new ConnectionHost({ database: f.services.database!, secrets: { resolve: async () => 'original-private-credential' },
    adapters: [{ adapterId: 'sample', publication: f.adapter, test: async () => ({ authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }) }] })
  const restored = new PublicationHost({ connections, bindings: f.services.bindings!, conversation: f.conversation }); cleanup.push(() => restored.close())
  await vi.waitFor(() => expect(restored.observation(f.binding.bindingId, 1)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' }))
  expect(restored.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched).toHaveLength(1)
  await expect(restored.retry({ operationId: original.operationId }, { actor: { kind: 'user', id: 'original-user' } })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  expect(restored.store.list(f.binding)[1]?.state).toBe('pending')
}, 15_000)

it('source replacement exposes a retained source gap without adopting a new cut or mutating the original Agent', async () => {
  const f = await fixture(), original = f.services.publication!.store.checkpoint(f.binding, f.binding.sourceCheckpoints[0]!), metadata = await readFile(f.storePath)
  await rename(f.transcript, join(f.root, 'retained-source.jsonl'))
  await writeFile(f.transcript, row('replacement-speech'))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, 1)).toEqual({ state: 'unavailable', reason: 'source-gap' }), { timeout: 5_000 })
  expect(f.services.publication!.store.checkpoint(f.binding, f.binding.sourceCheckpoints[0]!)).toEqual(original)
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
  await appendFile(f.transcript, row('retry-speech'))
  await vi.waitFor(() => expect(f.dispatched).toHaveLength(1))
  deadlines[0]!.abort()
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding)[0]?.state).toBe('unknown'))
  f.adapter.inspect = async () => ({ state: 'not-applied', reason: 'platform-rejected' })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding)[0]?.state).toBe('not-applied'))
  f.adapter.inspect = async () => null
  const original = f.services.publication!.store.list(f.binding)[0]!
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
  await vi.waitFor(() => expect(f.services.publication!.store.list(parallel.binding)[0]?.state).toBe('confirmed'), { timeout: 5_000 })
  expect(f.services.publication!.store.list(f.binding)[0]?.state).toBe('dispatching')
  const source = await f.client.readConversationChanges(f.binding.agentSessionId, { checkpoint: f.binding.sourceCheckpoints[0]! })
  expect(source.items.map(item => item.id)).toEqual(['parallel-speech'])
  expect(f.client.connect).not.toHaveBeenCalled()
  finishSlow({ state: 'confirmed', mapping: { messageId: 'slow-message' } })
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding)[0]?.state).toBe('confirmed'))
  expect(f.dispatched).toHaveLength(2)
}, 15_000)

it('closing while current human authorization is pending retains the original non-applied outcome', async () => {
  const f = await fixture(async () => ({ state: 'not-applied', reason: 'platform-rejected' }))
  await appendFile(f.transcript, row('original-not-applied'))
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding)[0]?.state).toBe('not-applied'))
  const original = f.services.publication!.store.list(f.binding)[0]!
  let approve!: () => void
  const current = new Promise<void>(resolve => { approve = resolve })
  const retry = f.services.publication!.retry({ operationId: original.operationId }, { actor: { kind: 'user', id: 'original-user' }, assertCurrent: () => current })
  f.services.publication!.close(); approve()
  await expect(retry).rejects.toMatchObject({ code: 'PUBLICATION_OWNER_UNAVAILABLE' })
  expect(f.services.publication!.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched).toHaveLength(1)
}, 15_000)
