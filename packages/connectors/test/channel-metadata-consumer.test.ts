import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/dist/index.js'
import type { ChannelMetadataChange, ChannelMetadataSubject } from '@agentmux/core/connections'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const actor = { application: feishuConfig.application, idType: 'open_id', userId: 'original-external-user' }
const actorSubject: ChannelMetadataSubject = { kind: 'actor', actor }
const groupSubject: ChannelMetadataSubject = { kind: 'conversation', externalConversationId: 'original-room' }
const encryption = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (value: string) => Buffer.from(value), decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }) }
async function fixture() {
  const f = await ingressFixture(true, feishuConfig); cleanup.push(f.close)
  const transport = feishuSdkTransport(), fallback = transport.request.getMockImplementation()!
  let actorName = 'Original native person', groupName = 'Original native group', failure = false
  transport.request.mockImplementation(async input => {
    if (input.url?.includes('/contact/v3/users/')) {
      if (failure) throw Error('Private lookup failure and credential details')
      return { code: 0, data: { user: { open_id: actor.userId, name: actorName, avatar: { avatar_240: 'https://cdn.example/person.png' }, email: 'private-field@example.test' } } }
    }
    if (input.url?.includes('/im/v1/chats/')) {
      if (failure) throw Error('Private native group failure')
      return { code: 0, data: { name: groupName, avatar: 'https://cdn.example/group.png' } }
    }
    return await fallback(input)
  })
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(input => transport.request(input))
  const directory = join(f.root, 'desktop-metadata'), changes: ChannelMetadataChange[] = []
  const open = async () => {
    // Default registry, original private Connection owner and actual receiver lifecycle.
    const services = await createDesktopConnections({ directory, encryption, bindings: { spatial: f.spatial, checkpoint: ref => f.client.conversationCheckpoint(ref) }, ingress: { core: hostId => hostId === 'local' ? f.client : undefined } })
    cleanup.push(() => services.close())
    services.onChannelMetadataChanged(change => changes.push(change))
    const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'metadata.sock'), connections: services.connections, spatialState: f.spatial, coreClients: f.coreClients })
    await server.start(); cleanup.push(() => server.stop())
    const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sdk.dispose())
    const cli = async (args: string[], input?: unknown) => {
      const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'metadata', ...args], objectCliEnvironment(f.root), input === undefined ? '' : JSON.stringify(input))
      expect(output.code, output.stdout + output.stderr).toBe(0)
      return JSON.parse(output.stdout).result
    }
    return { services, server, sdk, cli }
  }
  const opened = await open(), credential = await opened.services.secrets.store({ operationId: 'metadata-credential', secret: 'private-fixture-credential' })
  const config = { ...feishuConfig, credentialRef: credential.credentialRef }
  await opened.sdk.call('connection.configure', { operationId: 'metadata-configure', expectedRevision: null, connection: config })
  expect(await opened.sdk.call('connection.bind', f.input)).toMatchObject({ state: 'applied' })
  expect(await opened.sdk.call('connection.grant', f.grant)).toMatchObject({ state: 'applied' })
  await vi.waitFor(() => expect(transport.sockets).toHaveLength(1))
  const get = (subject = actorSubject) => opened.sdk.call('connection.metadata.get', { connectionId: config.connectionId, subject })
  const submit = async (suffix: string) => {
    const payload = feishuPayload({ message_id: 'metadata-message-' + suffix }); payload.header.event_id = 'metadata-event-' + suffix
    await transport.receive(payload)
    expect(transport.ack().at(-1)).toEqual({ code: 200 })
  }
  return { ...f, ...opened, config, transport, changes, get, open, submit,
    source: (person: string, group: string, fail = false) => { actorName = person; groupName = group; failure = fail },
    requests: () => transport.request.mock.calls.filter(([request]) => /\/(contact\/v3\/users|im\/v1\/chats)\//.test(request.url ?? '')) }
}

it('default Desktop native SDK intake reaches the same typed metadata owner through public SDK and compiled CLI, with durable isolation and exact clear', async () => {
  const f = await fixture()
  const before = await f.get(); expect(before.entry).toMatchObject({ cacheRevision: null, observation: { state: 'unknown', reason: 'not-observed' } })
  expect(f.requests()).toHaveLength(0)
  await f.submit('first')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  await vi.waitFor(async () => expect((await f.get()).entry.observation).toMatchObject({ state: 'observed', profile: { name: 'Original native person', avatarUrl: 'https://cdn.example/person.png' } }))
  await vi.waitFor(async () => expect((await f.get(groupSubject)).entry.observation).toMatchObject({ state: 'observed', profile: { name: 'Original native group' } }))
  expect(f.changes).toContainEqual({ connectionId: f.config.connectionId, application: f.config.application, subject: groupSubject })
  const cached = await f.get(), count = f.requests().length
  expect(await f.cli(['get', '--input', '-'], { connectionId: f.config.connectionId, subject: actorSubject })).toEqual(cached)
  expect(await f.cli(['ls', '--connection', f.config.connectionId, '--kind', 'actor', '--limit', '1'])).toMatchObject({ entries: [cached.entry], next: null })
  expect(f.requests()).toHaveLength(count)
  expect((await f.get({ kind: 'actor', actor: { ...actor, idType: 'user_id' } })).entry.observation.profile).toBeNull()
  await expect(f.get({ kind: 'actor', actor: { ...actor, application: { ...actor.application, appId: 'another-app' } } })).rejects.toMatchObject({ code: 'INVALID_CHANNEL_METADATA' })
  const otherConfig = { ...f.config, connectionId: 'isolated-app', application: { ...f.config.application, appId: 'another-app' }, enabled: false }
  await f.sdk.call('connection.configure', { operationId: 'metadata-other', expectedRevision: null, connection: otherConfig })
  const other = await f.sdk.call('connection.metadata.get', { connectionId: otherConfig.connectionId, subject: { kind: 'actor', actor: { ...actor, application: otherConfig.application } } })
  expect(other.entry.observation.profile).toBeNull()
  const otherGroup = await f.sdk.call('connection.metadata.get', { connectionId: otherConfig.connectionId, subject: groupSubject })
  expect(otherGroup.entry.observation).toMatchObject({ state: 'unknown', profile: null, reason: 'not-observed' })
  const retained = new Uint8Array([0, 255, 128, 1])
  // An unrelated native effect remains private to the original Channel namespace.
  f.services.database!.prepare('INSERT INTO channel_storage VALUES (?,?,?,?,?,?,?)').run(f.config.adapterId, f.config.application.domain, f.config.application.appId, 'retained-operation:unknown', 'retained-revision', 'bytes', retained)
  const secondSubject: ChannelMetadataSubject = { kind: 'actor', actor: { ...actor, userId: 'second-human' } }
  // A second exact metadata subject creates a real bounded second page through native refresh.
  await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: secondSubject })
  const firstPage = await f.sdk.call('connection.metadata.ls', { connectionId: f.config.connectionId, kind: 'actor', limit: 1 })
  expect(firstPage.entries).toHaveLength(1); expect(firstPage.next).toEqual(expect.any(String))
  const secondPage = await f.sdk.call('connection.metadata.ls', { connectionId: f.config.connectionId, kind: 'actor', limit: 1, cursor: firstPage.next! })
  expect(secondPage.entries).toHaveLength(1); expect(secondPage.next).toBeNull()
  expect(firstPage.entries[0]!.subject).not.toEqual(secondPage.entries[0]!.subject)
  expect(JSON.stringify([firstPage, secondPage])).not.toMatch(/private-field|private-fixture|retained-operation|tenant_access_token/)
  const disabled = { ...f.config, enabled: false }
  await f.sdk.call('connection.configure', { operationId: 'metadata-disable', expectedRevision: 1, connection: disabled })
  expect((await f.get()).entry).toEqual(cached.entry)
  await f.sdk.dispose(); await f.server.stop(); f.services.close()
  const reopened = await f.open()
  const restored = await reopened.cli(['get', '--input', '-'], { connectionId: f.config.connectionId, subject: actorSubject })
  expect(restored.entry).toEqual(cached.entry); expect(restored.connectionRevision).toBe(2)
  await expect(reopened.sdk.call('connection.metadata.clear', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject, expectedCacheRevision: cached.entry.cacheRevision })).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  await expect(reopened.sdk.call('connection.metadata.clear', { connectionId: f.config.connectionId, expectedConnectionRevision: 2, subject: actorSubject, expectedCacheRevision: 'wrong-revision' })).rejects.toMatchObject({ code: 'CHANNEL_STORAGE_CONFLICT' })
  const cleared = await reopened.cli(['clear', '--input', '-'], { connectionId: f.config.connectionId, expectedConnectionRevision: 2, subject: actorSubject, expectedCacheRevision: cached.entry.cacheRevision })
  expect(cleared).toMatchObject({ cleared: true, entry: { cacheRevision: null, observation: { state: 'unknown', profile: null } } })
  const remaining = await reopened.sdk.call('connection.metadata.ls', { connectionId: f.config.connectionId, kind: 'actor' })
  expect(remaining.entries).toHaveLength(1); expect(remaining.entries[0]!.subject).toEqual(secondSubject)
  expect(new Uint8Array(reopened.services.database!.prepare('SELECT value FROM channel_storage WHERE storage_key=?').get('retained-operation:unknown')!.value as Uint8Array)).toEqual(retained)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 20_000)

it('native group rename refreshes only its original display cache and notifies; failed observations retain the group, authority and healthy input', async () => {
  const f = await fixture(); await f.submit('before-rename')
  await vi.waitFor(async () => expect((await f.get(groupSubject)).entry.observation.profile?.name).toBe('Original native group'))
  const binding = await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId }), graph = await f.spatial.read()
  const before = await f.get(groupSubject), requests = f.requests().length, changes = f.changes.length
  f.source('Renamed person', 'Renamed native group')
  const event = { schema: '2.0', header: { app_id: f.config.application.appId, event_type: 'im.chat.updated_v1', event_id: 'native-rename' }, event: { chat_id: 'original-room', after_change: { name: 'Renamed native group' } } }
  await f.transport.receive(event)
  expect(f.transport.ack().at(-1)).toEqual({ code: 200 })
  await vi.waitFor(async () => expect((await f.get(groupSubject)).entry.observation.profile?.name).toBe('Renamed native group'))
  expect(f.requests().slice(requests)).toHaveLength(1); expect(f.requests().at(-1)![0].url).toContain('/im/v1/chats/original-room')
  expect(f.changes.slice(changes)).toEqual([{ connectionId: f.config.connectionId, application: f.config.application, subject: groupSubject }])
  expect(await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })).toEqual(binding)
  expect(await f.spatial.read()).toEqual(graph)
  expect((await f.get(groupSubject)).entry.cacheRevision).not.toBe(before.entry.cacheRevision)
  f.source('Ignored failed person', 'Ignored failed group', true)
  const failed = await f.cli(['refresh', '--input', '-'], { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: groupSubject })
  expect(failed.entry.observation).toMatchObject({ state: 'unavailable', freshness: 'stale', reason: 'source-unconfirmed', profile: { name: 'Renamed native group' } })
  const failedActor = await f.sdk.call('connection.metadata.refresh', { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: actorSubject })
  expect(failedActor.entry.observation).toMatchObject({ state: 'unavailable', freshness: 'stale', profile: { name: 'Original native person' } })
  await f.submit('during-failure')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  expect(await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })).toEqual(binding)
  expect(JSON.stringify([failed, failedActor])).not.toMatch(/Private|Ignored failed/)
  f.source('Recovered person', 'Recovered group')
  const recovered = await f.cli(['refresh', '--input', '-'], { connectionId: f.config.connectionId, expectedConnectionRevision: 1, subject: groupSubject })
  expect(recovered.entry.observation).toMatchObject({ state: 'observed', freshness: 'current', profile: { name: 'Recovered group' } })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('compiled command and module discovery describe local reads, exact refresh/clear and preserved healthy input', async () => {
  const f = await fixture(), outputs: string[] = []
  for (const args of [['--help'], ['connection', 'metadata', '--help'], ['connection', 'metadata', 'clear', '--help'], ['connection', '--skill']]) {
    const result = await runCompiledObjectCli(args, objectCliEnvironment(f.root))
    expect(result.code, result.stderr).toBe(0); outputs.push(result.stdout)
  }
  expect(outputs[0]).toContain('connection')
  expect(outputs[1]).toContain('connection metadata get --input FILE|-')
  expect(outputs[1]).toContain('no network request')
  expect(outputs[2]).toContain('expectedConnectionRevision and expectedCacheRevision')
  expect(outputs[2]).toContain('unknown-effect resources')
  expect(outputs[3]).toContain('No cache result authorizes input, answers, permissions or sharing')
  expect(outputs[3]).toContain('query failure does not stop authenticated intake')
  expect(f.requests()).toHaveLength(0)
})
