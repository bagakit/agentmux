import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { REST } from '@discordjs/rest'
import { createBuiltinConnectionAdapters } from '../src/platform-adapters.js'
import type { FeishuAdapter } from '../src/adapters/feishu/index.js'
import type { ConnectionConfig } from '@agentmux/core/connections'
import { feishuConfig, feishuSdkTransport } from './fixtures/feishu.js'

const loaded = vi.hoisted(() => ({ feishu: 0, discord: 0, gate: undefined as Promise<void> | undefined, leaf: undefined as FeishuAdapter | undefined }))
vi.mock('../src/adapters/feishu/index.js', async importOriginal => {
  loaded.feishu++; await loaded.gate
  const original = await importOriginal<typeof import('../src/adapters/feishu/index.js')>()
  const test = original.FeishuAdapter.prototype.test
  vi.spyOn(original.FeishuAdapter.prototype, 'test').mockImplementation(function (...args) { loaded.leaf = this; return test.apply(this, args) })
  return original
})
vi.mock('../src/adapters/discord/index.js', async importOriginal => {
  loaded.discord++; await loaded.gate
  return await importOriginal()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('retiring unused adapters does not even load their leaf modules', async () => {
  const adapters = createBuiltinConnectionAdapters()
  for (const adapter of adapters) { adapter.releaseConnection?.('unused'); adapter.close?.() }
  await vi.dynamicImportSettled()
  expect(loaded.feishu).toBe(0); expect(loaded.discord).toBe(0)
})

it('a Feishu call pending leaf import completes after close without retaining clients', async () => {
  let release!: () => void
  loaded.gate = new Promise<void>(resolve => { release = resolve })
  const network = feishuSdkTransport()
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(network.http.request)
  const adapter = createBuiltinConnectionAdapters().find(item => item.adapterId === 'feishu')!
  const reading = adapter.test(feishuConfig, 'fixture-credential')
  await vi.waitFor(() => expect(loaded.feishu).toBe(1))
  adapter.close?.(); release()
  expect((await reading).authentication.state).toBe('ready')
  const late = () => loaded.leaf!.withClient(feishuConfig, 'fixture-credential', async client => client)
  expect(await late()).not.toBe(await late())
})

it('a Discord call pending leaf import completes after close with zero SDK sweepers', async () => {
  vi.useFakeTimers()
  let release!: () => void
  loaded.gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(REST.prototype, 'get').mockImplementation(async () => ({ id: '100', bot: { id: '200' } }))
  const adapter = createBuiltinConnectionAdapters().find(item => item.adapterId === 'discord')!
  const config: ConnectionConfig = { ...feishuConfig, adapterId: 'discord', application: { domain: 'discord.com', appId: '100' } }
  const before = vi.getTimerCount(), reading = adapter.test(config, 'fixture-credential')
  await vi.waitFor(() => expect(loaded.discord).toBe(1))
  adapter.close?.(); release()
  expect((await reading).authentication.state).toBe('ready')
  expect(vi.getTimerCount()).toBe(before)
})
