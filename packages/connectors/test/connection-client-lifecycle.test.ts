import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REST } from '@discordjs/rest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { ConnectionHost, createBuiltinConnectionAdapters, createConnectionServices, type ConnectionServices } from '@agentmux/connectors'
import type { ConnectionConfig } from '@agentmux/core/connections'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { DiscordClients } from '../src/adapters/discord/client.js'
import { feishuConfig, feishuSdkTransport } from './fixtures/feishu.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.useRealTimers(); vi.restoreAllMocks()
})
async function owner() {
  const directory = await mkdtemp(join(tmpdir(), 'amux-connector-client-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const services = await createConnectionServices({ directory }); cleanup.push(() => services.close())
  return services
}
async function configure(services: ConnectionServices, connection: ConnectionConfig, operationId: string, expectedRevision: number | null = null) {
  return (await services.connections.configure({ operationId, expectedRevision, connection })).connection
}
async function credential(services: ConnectionServices, operationId = 'original-credential') {
  return (await services.secrets.store({ operationId, secret: 'fixture-' + operationId })).credentialRef
}

it('retires Feishu clients through original configure/delete/close without cancelling an admitted request', async () => {
  const network = feishuSdkTransport()
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(network.http.request)
  const original = FeishuAdapter.prototype.test
  let leaf!: FeishuAdapter
  vi.spyOn(FeishuAdapter.prototype, 'test').mockImplementation(function (config, secret) { leaf = this; return original.call(this, config, secret) })
  const services = await owner(), ref = await credential(services)
  let record = await configure(services, { ...feishuConfig, credentialRef: ref }, 'configure-original')
  await services.connections.test({ connectionId: record.config.connectionId })
  const client = await leaf.withClient(record.config, 'fixture-original-credential', async value => value)
  await services.connections.test({ connectionId: record.config.connectionId })
  expect(await leaf.withClient(record.config, 'fixture-original-credential', async value => value)).toBe(client)
  record = await configure(services, { ...record.config, label: 'Renamed original' }, 'rename-original', record.revision)
  expect(await leaf.withClient(record.config, 'fixture-original-credential', async value => value)).toBe(client)
  record = await configure(services, { ...record.config, enabled: false }, 'disable-original', record.revision)
  expect(await leaf.withClient(record.config, 'fixture-original-credential', async value => value)).not.toBe(client)
  record = await configure(services, { ...record.config, enabled: true }, 'enable-original', record.revision)
  const retained = await leaf.withClient(record.config, 'fixture-original-credential', async value => value)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached = false
  const originalRequest = network.request.getMockImplementation()!
  network.request.mockImplementation(async input => {
    if (input.url?.endsWith('/fixture-held')) { reached = true; await held; return { original: 'completed' } }
    return originalRequest(input)
  })
  const abort = new AbortController()
  const reading = leaf.withClient(record.config, 'fixture-original-credential', value => value.request({ url: '/fixture-held', method: 'GET' }), abort.signal)
    .then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(reached).toBe(true))
  const deletion = { operationId: 'delete-original', connectionId: record.config.connectionId, expectedRevision: record.revision }
  await services.connections.delete!(deletion)
  expect(await services.connections.inspectDeletion!({ operationId: deletion.operationId })).toMatchObject({ operation: { status: 'deleted' } })
  const late = () => leaf.withClient(record.config, 'fixture-original-credential', async value => value)
  expect(await late()).not.toBe(retained)
  expect(await late()).not.toBe(await late())
  release(); expect(await reading).toEqual({ value: { original: 'completed' } }); expect(abort.signal.aborted).toBe(false)
  await services.close()
  expect(await late()).not.toBe(await late())
})

it('releases only the final Discord consumer, including after a deleted consumer arrives late', async () => {
  vi.useFakeTimers()
  const services = await owner(), ref = await credential(services)
  const config: ConnectionConfig = { connectionId: 'discord-first', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' }, label: 'Original bot', enabled: true, credentialRef: ref }
  const a = await configure(services, config, 'first'), b = await configure(services, { ...config, connectionId: 'discord-second' }, 'second')
  const restInstances: REST[] = []
  vi.spyOn(REST.prototype, 'get').mockImplementation(async function () { restInstances.push(this); return { id: '100', bot: { id: '200' } } })
  let leaf!: DiscordClients
  const original = DiscordClients.prototype.rest
  vi.spyOn(DiscordClients.prototype, 'rest').mockImplementation(function (...args) { leaf = this; return original.apply(this, args) })
  const before = vi.getTimerCount()
  await services.connections.test({ connectionId: a.config.connectionId }); await services.connections.test({ connectionId: b.config.connectionId })
  expect(restInstances).toHaveLength(2); expect(restInstances[0]).toBe(restInstances[1]); expect(vi.getTimerCount()).toBe(before + 2)
  await services.connections.delete!({ operationId: 'delete-first', connectionId: a.config.connectionId, expectedRevision: a.revision })
  expect(leaf.rest(a.config, 'fixture-original-credential')).toBe(restInstances[0])
  expect(vi.getTimerCount()).toBe(before + 2)
  await services.connections.delete!({ operationId: 'delete-second', connectionId: b.config.connectionId, expectedRevision: b.revision })
  expect(vi.getTimerCount()).toBe(before)
  const late = leaf.rest(a.config, 'fixture-original-credential')
  expect(leaf.rest(a.config, 'fixture-original-credential')).not.toBe(late); expect(vi.getTimerCount()).toBe(before)
})

it('stops replaced Discord SDK sweepers while keeping old requests and current reuse available', async () => {
  vi.useFakeTimers()
  const services = await owner(), ref = await credential(services)
  const config: ConnectionConfig = { connectionId: 'discord-rotation', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' }, label: 'Original bot', enabled: true, credentialRef: ref }
  const record = await configure(services, config, 'configure')
  const gets: REST[] = [], hash = vi.spyOn(REST.prototype, 'clearHashSweeper'), handlers = vi.spyOn(REST.prototype, 'clearHandlerSweeper')
  vi.spyOn(REST.prototype, 'get').mockImplementation(async function () { gets.push(this); return { id: '100', bot: { id: '200' } } })
  const original = DiscordClients.prototype.rest
  let leaf!: DiscordClients
  vi.spyOn(DiscordClients.prototype, 'rest').mockImplementation(function (...args) { leaf = this; return original.apply(this, args) })
  const before = vi.getTimerCount()
  await services.connections.test({ connectionId: config.connectionId })
  const old = gets[0]!, next = leaf.rest(config, 'replacement-credential')
  expect(next).not.toBe(old); expect(hash.mock.instances).toContain(old); expect(handlers.mock.instances).toContain(old)
  expect(vi.getTimerCount()).toBe(before + 2)
  expect(leaf.rest(config, 'replacement-credential')).toBe(next)
  const ref2 = await credential(services, 'replacement')
  await configure(services, { ...config, credentialRef: ref2 }, 'rotate', record.revision)
  expect(vi.getTimerCount()).toBe(before)
  await services.connections.test({ connectionId: config.connectionId })
  expect(vi.getTimerCount()).toBe(before + 2)
  await services.close(); expect(vi.getTimerCount()).toBe(before)
  expect(leaf.rest(config, 'replacement-credential')).not.toBe(leaf.rest(config, 'replacement-credential'))
  expect(vi.getTimerCount()).toBe(before)
})

it('keeps committed receipts and unrelated resource cleanup when a local adapter hook fails', async () => {
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
  const directory = await mkdtemp(join(tmpdir(), 'amux-connector-cleanup-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const first = { adapterId: 'fixture-a', test: vi.fn(), releaseConnection: () => { throw Error('controlled cleanup failure') }, close: () => { throw Error('controlled close failure') } }
  const second = { adapterId: 'fixture-b', test: vi.fn(), close: vi.fn() }
  const services = await createConnectionServices({ directory, adapters: [first, second] }); cleanup.push(() => services.close())
  const config: ConnectionConfig = { ...feishuConfig, adapterId: first.adapterId }
  const record = await configure(services, config, 'configure')
  const input = { operationId: 'delete', connectionId: config.connectionId, expectedRevision: record.revision }
  const receipt = await services.connections.delete!(input)
  expect(await services.connections.inspectDeletion!({ operationId: input.operationId })).toEqual({ operation: receipt })
  await services.close(); expect(second.close).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalledTimes(2)
})

it('an unavailable retention read leaves the original Feishu SDK call available without caching it', async () => {
  const network = feishuSdkTransport()
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(network.http.request)
  const original = FeishuAdapter.prototype.test
  let leaf!: FeishuAdapter
  vi.spyOn(FeishuAdapter.prototype, 'test').mockImplementation(function (config, secret) { leaf = this; return original.call(this, config, secret) })
  const services = await owner(), ref = await credential(services)
  const record = await configure(services, { ...feishuConfig, credentialRef: ref }, 'configure')
  vi.spyOn(ConnectionHost.prototype, 'readConfiguration').mockImplementation(() => { throw Error('controlled observation failure') })
  expect((await services.connections.test({ connectionId: record.config.connectionId })).observation.authentication.state).toBe('ready')
  const read = () => leaf.withClient(record.config, 'fixture-original-credential', async value => value)
  expect(await read()).not.toBe(await read())
})

it('retiring the native Discord client stops only maintenance timers while its HTTP request completes', async () => {
  let release!: () => void, reached = false
  const held = new Promise<void>(resolve => { release = resolve })
  const clients = new DiscordClients({ makeRequest: async () => {
    reached = true; await held
    return new Response(JSON.stringify({ id: '100', bot: { id: '200' } }), { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  cleanup.push(() => clients.close())
  const config: ConnectionConfig = { ...feishuConfig, connectionId: 'discord-held', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' } }
  const reading = clients.identity(config, 'fixture-credential').then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(reached).toBe(true))
  clients.releaseConnection(config.connectionId)
  release()
  expect(await reading).toEqual({ value: { botId: '200' } })
})

it('closing one adapter leaves the other adapter SDK reuse and retirement independent', async () => {
  vi.useFakeTimers()
  const instances: REST[] = []
  vi.spyOn(REST.prototype, 'get').mockImplementation(async function () { instances.push(this); return { id: '100', bot: { id: '200' } } })
  const adapters = createBuiltinConnectionAdapters(), discord = adapters.find(adapter => adapter.adapterId === 'discord')!
  cleanup.push(() => discord.close?.())
  adapters.find(adapter => adapter.adapterId === 'feishu')!.close?.()
  const config: ConnectionConfig = { ...feishuConfig, connectionId: 'independent-discord', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' } }
  const before = vi.getTimerCount()
  await discord.test(config, 'fixture-credential'); await discord.test(config, 'fixture-credential')
  expect(instances[0]).toBe(instances[1]); expect(vi.getTimerCount()).toBe(before + 2)
  discord.close?.(); expect(vi.getTimerCount()).toBe(before)
})

it.each(['registry', 'leaf'] as const)('direct ConnectionHost owns retirement eligibility for a %s adapter', async kind => {
  const network = feishuSdkTransport()
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(network.http.request)
  const original = FeishuAdapter.prototype.test
  let leaf!: FeishuAdapter
  vi.spyOn(FeishuAdapter.prototype, 'test').mockImplementation(function (config, secret) { leaf = this; return original.call(this, config, secret) })
  const directory = await mkdtemp(join(tmpdir(), 'amux-direct-client-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const host = new ConnectionHost({ databasePath: join(directory, 'connections.sqlite'), secrets: { resolve: async () => 'fixture-credential' }, adapters: kind === 'registry' ? createBuiltinConnectionAdapters() : [new FeishuAdapter()] })
  cleanup.push(() => host.close())
  const record = (await host.configure({ operationId: 'configure', expectedRevision: null, connection: feishuConfig })).connection
  await host.test({ connectionId: feishuConfig.connectionId })
  await host.delete({ operationId: 'delete', connectionId: feishuConfig.connectionId, expectedRevision: record.revision })
  const late = () => leaf.withClient(feishuConfig, 'fixture-credential', async client => client)
  expect(await late()).not.toBe(await late())
})
