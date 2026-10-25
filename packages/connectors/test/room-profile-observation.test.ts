import { afterEach, expect, it, vi } from 'vitest'
import { DefaultRestOptions } from '@discordjs/rest'
import { defaultHttpInstance, roomDiscoveryFixture } from './fixtures/room-discovery.js'
import { profileLoopback, deferred } from './fixtures/profile-loopback.js'
import { discordConfig } from './fixtures/discord.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const group = { kind: 'conversation' as const, externalConversationId: 'oc_original' }
async function feishu(read: (url: URL) => unknown | Promise<unknown>) {
  const wire = await profileLoopback(read); cleanup.push(wire.close)
  const request = defaultHttpInstance.request.bind(defaultHttpInstance)
  const f = await roomDiscoveryFixture(input => request({ ...input, url: wire.origin + new URL(input.url!).pathname })); cleanup.push(f.close)
  const get = () => f.sdk.call('connection.metadata.get', { connectionId: f.config.connectionId, subject: group })
  return { ...f, wire, get }
}
it('native group reads enrich the original durable public SDK and compiled CLI cache without ingress or extra reads', async () => {
  let source = { name: 'Native group', avatar: 'https://cdn.example/group.png' }
  const f = await feishu(url => ({ code: 0, data: url.pathname.endsWith('/chats') || url.pathname.endsWith('/search') ? { items: [{ chat_id: 'oc_catalog', ...source }], has_more: false } : { ...source, chat_status: 'normal', chat_mode: 'group' } }))
  expect((await f.get()).entry.observation.profile).toBeNull()
  expect((await f.sdk.call('connection.room.get', f.target)).observation.state).toBe('ready')
  const observed = await f.get()
  expect(observed.entry.observation.profile).toMatchObject({ name: source.name, avatarUrl: source.avatar })
  expect(f.wire.calls).toEqual(['/open-apis/im/v1/chats/oc_original'])
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.root + '/rooms.sock', 'connection', 'metadata', 'get', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify({ connectionId: f.config.connectionId, subject: group }))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.entry).toEqual(observed.entry)
  for (const method of ['connection.room.ls', 'connection.room.search'] as const) {
    source = { name: method, avatar: 'https://cdn.example/catalog.png' }
    const result = await f.sdk.call(method, { ...f.scope, ...(method === 'connection.room.search' ? { query: 'Native' } : {}), limit: 20 })
    expect(result.observation.state).toBe('ready')
    expect((await f.sdk.call('connection.metadata.get', { connectionId: f.config.connectionId, subject: { ...group, externalConversationId: 'oc_catalog' } })).entry.observation.profile).toMatchObject({ name: method, avatarUrl: source.avatar })
  }
  const other = { ...f.config, connectionId: 'other-application', application: { ...f.config.application, appId: 'another-app' }, enabled: false }
  await f.sdk.call('connection.configure', { operationId: 'other-application', expectedRevision: null, connection: other })
  expect((await f.sdk.call('connection.metadata.get', { connectionId: other.connectionId, subject: group })).entry.observation.profile).toBeNull()
  f.services.database!.exec("CREATE TEMP TRIGGER fail_optional_profile BEFORE UPDATE ON channel_storage BEGIN SELECT RAISE(FAIL, 'controlled optional cache failure'); END")
  expect((await f.sdk.call('connection.room.get', f.target)).observation.state).toBe('ready')
  expect((await f.get()).entry).toEqual(observed.entry)
}, 20_000)

it('late exact reads respect clear and catalog reads cannot overwrite a newer partial observation or refresh retained-avatar age', async () => {
  let native: Record<string, unknown> = { name: 'Before', avatar: 'https://cdn.example/earlier.png' }
  let held: ReturnType<typeof deferred<unknown>> | undefined, entered = deferred<void>()
  let holdCatalog = false, holdExact = false
  const f = await feishu(async url => {
    if (holdCatalog && url.pathname.endsWith('/chats') || holdExact && url.pathname.endsWith('/oc_original')) { entered.resolve(); return await held!.promise }
    return { code: 0, data: native }
  })
  await f.sdk.call('connection.room.get', f.target)
  const first = await f.get(), firstTime = first.entry.observation.profile!.observedAt
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 100)
  held = deferred(); holdCatalog = true
  const catalog = f.sdk.call('connection.room.ls', f.scope); await entered.promise
  vi.mocked(Date.now).mockReturnValue(now + 200)
  native = { name: 'New partial' }
  await f.sdk.call('connection.metadata.refresh', { ...f.scope, subject: group })
  const partial = await f.get()
  expect(partial.entry.observation.profile).toMatchObject({ name: 'New partial', avatarUrl: 'https://cdn.example/earlier.png', observedAt: firstTime })
  expect(partial.entry.observation.checkedAt).toBe(now + 200)
  vi.mocked(Date.now).mockReturnValue(now + 300)
  held.resolve({ code: 0, data: { items: [{ chat_id: 'oc_original', name: 'Older catalog' }], has_more: false } }); await catalog
  expect((await f.get()).entry).toEqual(partial.entry)
  holdCatalog = false; holdExact = true; held = deferred(); entered = deferred()
  const exact = f.sdk.call('connection.room.get', f.target); await entered.promise
  await f.sdk.call('connection.metadata.clear', { ...f.scope, subject: group, expectedCacheRevision: partial.entry.cacheRevision })
  held.resolve({ code: 0, data: { name: 'Old in-flight', avatar: 'https://cdn.example/late.png' } }); await exact
  expect((await f.get()).entry.observation.profile).toBeNull()
  holdExact = false
  await f.sdk.call('connection.room.get', f.target)
  expect((await f.get()).entry.observation.profile?.name).toBe('New partial')
  const current = await f.get()
  holdExact = true; held = deferred(); entered = deferred()
  const revised = f.sdk.call('connection.room.get', f.target); await entered.promise
  await f.sdk.call('connection.configure', { operationId: 'changed-original-connection', expectedRevision: 1, connection: { ...f.config, enabled: false } })
  held.resolve({ code: 0, data: { name: 'Late prior connection' } })
  expect((await revised).observation.reason).toBe('connection-revised')
  expect((await f.get()).entry).toEqual(current.entry)
}, 20_000)

it('native Discord recipients and group-DM icons reach original public metadata and distinguish omitted fields from confirmed absence', async () => {
  let channel: Record<string, unknown> = { id: '300', type: 3, name: 'Direct group', icon: 'group_icon', recipients: [{ id: '400', username: 'native-user', global_name: 'Native person', avatar: 'person_avatar' }] }
  const wire = await profileLoopback(url => url.pathname.endsWith('/oauth2/applications/@me') ? { id: '100', name: 'Application', bot: { id: '200', username: 'Bot' } } : channel); cleanup.push(wire.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation((url, init) => { const source = new URL(url); return fetch(wire.origin + source.pathname + source.search, init as RequestInit) })
  const f = await roomDiscoveryFixture(); cleanup.push(f.close)
  await f.sdk.call('connection.configure', { operationId: 'discord-native-profile', expectedRevision: null, connection: { ...discordConfig, credentialRef: f.config.credentialRef } })
  const scope = { connectionId: discordConfig.connectionId, expectedConnectionRevision: 1 }, target = { ...scope, externalConversationId: '300' }
  const subject = { kind: 'actor' as const, actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' } }
  const get = (actor = false) => f.sdk.call('connection.metadata.get', { connectionId: scope.connectionId, subject: actor ? subject : { kind: 'conversation', externalConversationId: '300' } })
  await f.sdk.call('connection.room.get', target); await f.sdk.call('connection.room.members', target)
  const person = await get(true), group = await get()
  expect(person.entry.observation.profile).toMatchObject({ name: 'Native person', avatarUrl: 'https://cdn.discordapp.com/avatars/400/person_avatar.png?size=128' })
  expect(group.entry.observation.profile).toMatchObject({ name: 'Direct group', avatarUrl: 'https://cdn.discordapp.com/channel-icons/300/group_icon.png?size=128' })
  expect(wire.calls.filter(path => path.endsWith('/users/400'))).toHaveLength(0)
  const before = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(before + 100)
  channel = { id: '300', type: 3, name: 'Partial group', recipients: [{ id: '400', username: 'Changed person' }] }
  await f.sdk.call('connection.room.get', target); await f.sdk.call('connection.room.members', target)
  expect((await get()).entry.observation.profile).toMatchObject({ name: 'Partial group', avatarUrl: group.entry.observation.profile!.avatarUrl, observedAt: group.entry.observation.profile!.observedAt })
  expect((await get(true)).entry.observation.profile).toMatchObject({ name: 'Changed person', avatarUrl: person.entry.observation.profile!.avatarUrl, observedAt: person.entry.observation.profile!.observedAt })
  vi.mocked(Date.now).mockReturnValue(before + 200)
  channel = { ...channel, icon: null, recipients: [{ id: '400', username: 'No avatar', avatar: null }] }
  await f.sdk.call('connection.room.get', target); await f.sdk.call('connection.room.members', target)
  expect((await get()).entry.observation.profile?.avatarUrl).toBeUndefined()
  expect((await get(true)).entry.observation.profile?.avatarUrl).toBeUndefined()
  channel = { id: '300', type: 0, name: 'Guild channel', guild_id: '500', icon: 'not-a-channel-avatar' }
  await f.sdk.call('connection.room.get', target)
  expect((await get()).entry.observation.profile?.avatarUrl).toBeUndefined()
  expect((await f.sdk.call('connection.room.members', target)).observation.state).toBe('unknown')
}, 20_000)
