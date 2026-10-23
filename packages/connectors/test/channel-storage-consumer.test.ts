import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionHost, type ConnectionAdapter } from '../src/connection-host.js'
import { ChannelStorage } from '../src/channel-storage.js'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { RoomBindingHost } from '../src/room-binding.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { createBuiltinConnectionAdapters } from '../src/platform-adapters.js'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import type { ChannelActorProfileObservation, ConnectionActor } from '@agentmux/core/connections'
import { ingressFixture } from './fixtures/ingress.js'
import { context } from './fixtures/room-binding.js'
import { feishuConfig, feishuPayload, feishuSdkTransport, startFeishuTransport } from './fixtures/feishu.js'

const closes: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const actor: ConnectionActor = { application: feishuConfig.application, idType: 'open_id', userId: 'original-external-user' }
const profileResponse = (name = 'Native human', id = actor.userId) => ({ code: 0, data: { user: { open_id: id, name, avatar: { avatar_240: 'https://cdn.example/avatar.png' }, email: 'private-native-field@example.test' } } })
async function fixture(builtin = false) {
  const original = await ingressFixture(true, feishuConfig); closes.push(original.close)
  const transport = feishuSdkTransport(), adapter = new FeishuAdapter({ http: transport.http })
  if (builtin) vi.spyOn(defaultHttpInstance, 'request').mockImplementation(input => transport.request(input))
  const databasePath = join(original.root, 'channel-storage.sqlite')
  const open = (adapters: readonly ConnectionAdapter[] = builtin ? createBuiltinConnectionAdapters() : [adapter]) => new ConnectionHost({ databasePath, adapters, secrets: { resolve: async () => 'fixture-credential' } })
  let connections = open(); closes.push(() => connections.close())
  await connections.configure({ operationId: 'channel-configure', expectedRevision: null, connection: feishuConfig })
  const bindings = new RoomBindingHost({ connections, spatial: original.spatial, checkpoint: ref => original.client.conversationCheckpoint(ref) }); connections.bindings = bindings
  expect((await bindings.bind(original.input, context)).state).toBe('applied')
  expect((await bindings.grant(original.grant, context)).state).toBe('applied')
  const ingress = new DurableIngressHost({ connections, bindings, authenticators: connections.ingressAuthenticators(), core: hostId => hostId === 'local' ? original.client : undefined })
  const receiver = await startFeishuTransport(connections.registeredAdapter('feishu')!.transport!, feishuConfig, ingress, () => connections.channelStorage(feishuConfig)); closes.push(receiver.close)
  await vi.waitFor(() => expect(receiver.observation().transport.state).toBe('ready'))
  return { ...original, transport, adapter, ingress, bindings, host: () => connections,
    reopen() { receiver.close(); connections.close(); connections = open(); return connections } }
}
function profileRequests(f: Awaited<ReturnType<typeof fixture>>) { return f.transport.request.mock.calls.filter(([request]) => request.url?.includes('/contact/v3/users/')) }
function actorRow(f: Awaited<ReturnType<typeof fixture>>) {
  const storage = f.host().channelStorage(feishuConfig), entry = storage.list().entries.find(value => value.key.startsWith('actor-profile:'))
  if (!entry) throw Error('The real native actor cache consumer did not write a value')
  return { storage, row: storage.get(entry.key)! }
}
it('the default Desktop adapter registry joins native SDK intake to the original durable actor cache', async () => {
  const f = await fixture(true), request = f.transport.request.getMockImplementation()!
  f.transport.request.mockImplementation(input => input.url?.includes('/contact/v3/users/') ? Promise.resolve(profileResponse('Default registered human')) : request(input))
  await submit(f, 'default-registry')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(f.host().readChannelActor(feishuConfig.connectionId, actor)).toMatchObject({ state: 'observed', profile: { name: 'Default registered human' } }))
  expect(profileRequests(f)).toHaveLength(1)
  expect(actorRow(f).row.value.kind).toBe('json')
})
async function submit(f: Awaited<ReturnType<typeof fixture>>, suffix: string) {
  const payload = feishuPayload({ message_id: 'message-' + suffix }); payload.header.event_id = 'event-' + suffix
  await f.transport.receive(payload)
  expect(f.transport.ack().at(-1)).toEqual({ code: 200 })
  const record = (await f.ingress.list({ connectionId: feishuConfig.connectionId })).ingresses.find(value => value.externalMessageId === payload.event.message.message_id)!
  expect(record).toBeDefined()
  return await f.ingress.dispatch(record.ingressId)
}

it('native SDK intake ACKs and dispatches while profile lookup is pending; the adapter cache survives reopen and aliases', async () => {
  const f = await fixture(), originalRequest = f.transport.request.getMockImplementation()!
  let release!: (value: ReturnType<typeof profileResponse>) => void
  const pending = new Promise<ReturnType<typeof profileResponse>>(resolve => { release = resolve })
  f.transport.request.mockImplementation(async input => {
    if (input.url?.includes('/contact/v3/users/')) { expect(f.transport.ack()).toContainEqual({ code: 200 }); return pending }
    return originalRequest(input)
  })
  const first = await submit(f, 'first')
  await vi.waitFor(() => expect(profileRequests(f)).toHaveLength(1))
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(first.ingress?.input?.author).toMatchObject({ actor, grantId: f.grant.grantId })
  expect(f.host().readChannelActor(feishuConfig.connectionId, actor).profile).toBeNull()
  release(profileResponse())
  await vi.waitFor(() => expect(f.host().readChannelActor(feishuConfig.connectionId, actor)).toMatchObject({ state: 'observed', freshness: 'current', actor, profile: { name: 'Native human', avatarUrl: 'https://cdn.example/avatar.png' } }))
  const cached = f.host().readChannelActor(feishuConfig.connectionId, actor), { row } = actorRow(f)
  expect(f.host().readChannelActor(feishuConfig.connectionId, { ...actor, application: { appId: actor.application.appId, domain: actor.application.domain } })).toEqual(cached)
  expect(f.host().readChannelActor(feishuConfig.connectionId, { ...actor, idType: 'user_id' }).profile).toBeNull()
  expect(JSON.stringify(row)).not.toMatch(/private-native-field|fixture-credential/)
  const second = await submit(f, 'second')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  expect(second.ingress?.input?.channelProfile).toEqual(cached)
  const queued = await new (await import('../../core/dist/index.js')).DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(second.ingress!.input!.operationId)
  expect(queued?.envelope.channelProfile).toEqual(cached)
  expect(profileRequests(f)).toHaveLength(1)
  f.reopen()
  expect(f.host().readChannelActor(feishuConfig.connectionId, actor)).toEqual(cached)
  const alias = { ...feishuConfig, connectionId: 'same-native-application-alias', label: 'Another local label' }
  await f.host().configure({ operationId: 'channel-alias', expectedRevision: null, connection: alias })
  expect(f.host().readChannelActor(alias.connectionId, actor)).toEqual(cached)
  await f.host().observeChannelActor(alias, actor)
  expect(profileRequests(f)).toHaveLength(1)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 20_000)

it('failed and foreign native observations retain confirmed identity without blocking following input or becoming permanent absence', async () => {
  const f = await fixture(), originalRequest = f.transport.request.getMockImplementation()!
  let response: ReturnType<typeof profileResponse> | Error = profileResponse()
  f.transport.request.mockImplementation(async input => {
    if (!input.url?.includes('/contact/v3/users/')) return originalRequest(input)
    if (response instanceof Error) throw response
    return response
  })
  await submit(f, 'original')
  await vi.waitFor(() => expect(f.host().readChannelActor(feishuConfig.connectionId, actor).state).toBe('observed'))
  const { storage, row } = actorRow(f)
  const stale = { ...(row.value.kind === 'json' ? row.value.value as object : {}), checkedAt: 0 }
  storage.put({ key: row.key, expectedRevision: row.revision, value: { kind: 'json', value: stale } })
  response = new Error('Private native request detail')
  await submit(f, 'failed-lookup')
  await vi.waitFor(() => expect(f.host().readChannelActor(feishuConfig.connectionId, actor)).toMatchObject({ state: 'unavailable', freshness: 'stale', profile: { name: 'Native human' } }))
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  response = profileResponse('Wrong person', 'foreign-user')
  await submit(f, 'foreign-lookup')
  await vi.waitFor(() => expect(profileRequests(f)).toHaveLength(3))
  await vi.waitFor(() => expect(f.host().readChannelActor(feishuConfig.connectionId, actor).reason).toBe('source-unconfirmed'))
  expect(f.host().readChannelActor(feishuConfig.connectionId, actor).profile?.name).toBe('Native human')
  response = profileResponse('Recovered human')
  await submit(f, 'recovered')
  await vi.waitFor(() => expect(f.host().readChannelActor(feishuConfig.connectionId, actor)).toMatchObject({ state: 'observed', freshness: 'current', profile: { name: 'Recovered human' } }))
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(4))
  expect(JSON.stringify(f.host().readChannelActor(feishuConfig.connectionId, actor))).not.toMatch(/Private native|Wrong person/)
}, 20_000)

it('profile storage failure leaves actual SDK ACK and original Core input available', async () => {
  const f = await fixture()
  f.host().channelStorage(feishuConfig)
  f.host().database.exec('DROP TABLE channel_storage')
  await submit(f, 'unavailable-storage')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.transport.ack()).toEqual([{ code: 200 }])
  expect(f.host().readChannelActor(feishuConfig.connectionId, actor)).toMatchObject({ state: 'unknown', reason: 'storage-unconfirmed', profile: null })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 15_000)

it('two adapter protocols consume isolated durable JSON/bytes with exact CAS, bounded key-only pages and retained resource isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-storage-')); closes.push(() => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'connection.sqlite')
  const second: ConnectionAdapter = { adapterId: 'other-protocol', test: async () => { throw Error('No credential test requested') }, channelProfiles: {
    readActor: input => {
      const stored = input.storage.get('member:' + input.actor.idType + ':' + input.actor.userId)
      return stored?.value.kind === 'json' ? stored.value.value as ChannelActorProfileObservation : { actor: input.actor, state: 'unknown', profile: null, checkedAt: 0, freshness: 'unknown', reason: 'not-observed' }
    },
    refreshActor: async input => {
      const key = 'member:' + input.actor.idType + ':' + input.actor.userId, prior = input.storage.get(key)
      const value = { actor: input.actor, state: 'observed' as const, profile: { name: 'Second protocol member', observedAt: 1 }, checkedAt: 1, freshness: 'current' as const }
      input.storage.put({ key, expectedRevision: prior?.revision ?? null, value: { kind: 'json', value } }); return value
    }
  } }
  let host = new ConnectionHost({ databasePath, secrets: { resolve: async () => 'private-token' }, adapters: [second] }); closes.push(() => host.close())
  const config = { ...feishuConfig, adapterId: second.adapterId, connectionId: 'second-native' }
  await host.configure({ operationId: 'configure-second', expectedRevision: null, connection: config })
  await host.observeChannelActor(config, actor)
  expect(host.readChannelActor(config.connectionId, actor).profile?.name).toBe('Second protocol member')
  const native = host.channelStorage(feishuConfig), other = host.channelStorage(config), differentApp = host.channelStorage({ ...feishuConfig, application: { ...feishuConfig.application, appId: 'another-native-app' } })
  const created = native.put({ key: 'same-key', expectedRevision: null, value: { kind: 'json', value: { native: 'first' } } })
  other.put({ key: 'same-key', expectedRevision: null, value: { kind: 'json', value: { native: 'second' } } })
  expect(native.get('same-key')?.value).toEqual({ kind: 'json', value: { native: 'first' } }); expect(differentApp.get('same-key')).toBeNull()
  expect(() => native.put({ key: 'same-key', expectedRevision: null, value: { kind: 'json', value: 'conflict' } })).toThrowError(expect.objectContaining({ code: 'CHANNEL_STORAGE_CONFLICT' }))
  const updated = native.put({ key: created.key, expectedRevision: created.revision, value: { kind: 'json', value: { native: 'updated' } } })
  expect(() => native.delete({ key: created.key, expectedRevision: created.revision })).toThrowError(expect.objectContaining({ code: 'CHANNEL_STORAGE_CONFLICT' }))
  expect(native.delete({ key: updated.key, expectedRevision: updated.revision })).toBe(true)
  const recreated = native.put({ key: created.key, expectedRevision: null, value: { kind: 'json', value: 'new identity' } })
  expect(recreated.revision).not.toBe(created.revision)
  expect(() => native.put({ key: created.key, expectedRevision: updated.revision, value: { kind: 'json', value: 'stale' } })).toThrowError(expect.objectContaining({ code: 'CHANNEL_STORAGE_CONFLICT' }))
  const bytes = new Uint8Array([0, 255, 1, 128]), retained = native.put({ key: 'retained-operation:unknown', expectedRevision: null, value: { kind: 'bytes', value: bytes } })
  const metadata = native.put({ key: 'actor-profile:clearable', expectedRevision: null, value: { kind: 'json', value: { name: 'Clearable' } } })
  native.delete({ key: metadata.key, expectedRevision: metadata.revision })
  expect(native.get(retained.key)?.value).toEqual({ kind: 'bytes', value: bytes })
  host.database.prepare('UPDATE channel_storage SET value_kind=? WHERE adapter_id=? AND domain=? AND app_id=? AND storage_key=?').run('unknown-encoding', feishuConfig.adapterId, feishuConfig.application.domain, feishuConfig.application.appId, retained.key)
  expect(() => native.get(retained.key)).toThrowError(expect.objectContaining({ code: 'CHANNEL_STORAGE_UNAVAILABLE' }))
  host.database.prepare('UPDATE channel_storage SET value_kind=?,value=? WHERE adapter_id=? AND domain=? AND app_id=? AND storage_key=?').run('bytes', 'not-original-bytes', feishuConfig.adapterId, feishuConfig.application.domain, feishuConfig.application.appId, retained.key)
  expect(() => native.get(retained.key)).toThrowError(expect.objectContaining({ code: 'CHANNEL_STORAGE_UNAVAILABLE' }))
  expect(other.get('same-key')?.value).toEqual({ kind: 'json', value: { native: 'second' } })
  host.database.prepare('UPDATE channel_storage SET value=? WHERE adapter_id=? AND domain=? AND app_id=? AND storage_key=?').run(Buffer.from(bytes), feishuConfig.adapterId, feishuConfig.application.domain, feishuConfig.application.appId, retained.key)
  const first = native.list({ limit: 1 }); expect(first.entries).toHaveLength(1); expect(first.next).toEqual(expect.any(String))
  expect(first.entries[0]).toEqual({ key: retained.key, revision: retained.revision })
  expect(native.list({ limit: 1, after: first.next! }).entries).toEqual([{ key: recreated.key, revision: recreated.revision }])
  expect(() => other.list({ after: first.next! })).toThrowError(expect.objectContaining({ code: 'INVALID_CHANNEL_STORAGE_REQUEST' }))
  expect(() => native.list({ limit: 0 })).toThrowError(expect.objectContaining({ code: 'INVALID_CHANNEL_STORAGE_REQUEST' }))
  host.close(); host = new ConnectionHost({ databasePath, secrets: { resolve: async () => null }, adapters: [second] })
  expect(host.channelStorage(feishuConfig).get(retained.key)?.value).toEqual({ kind: 'bytes', value: bytes })
  expect(host.channelStorage(config).get('same-key')?.value).toEqual({ kind: 'json', value: { native: 'second' } })
  expect(host.readChannelActor(config.connectionId, actor).profile?.name).toBe('Second protocol member')
  // Reopening the same owner supplies the same generic mechanism, not another conversation store.
  expect(new ChannelStorage(host.database).namespace(feishuConfig).list().entries).toHaveLength(2)
})
