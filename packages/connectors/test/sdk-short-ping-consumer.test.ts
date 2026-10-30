import { afterEach, expect, it, vi } from 'vitest'
import { WSClient, EventDispatcher, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { feishuSocketTransport } from './fixtures/feishu-socket.js'
import { createRequire } from 'node:module'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

declare const __RECEIVER_SDK_ENTRY__: string
if (process.env.RECEIVER_SDK_LOADED && process.env.RECEIVER_SDK_FORMAT !== 'esm') {
  const loaded = createRequire(import.meta.url).cache[__RECEIVER_SDK_ENTRY__]?.exports.WSClient === WSClient ||
    readFileSync(process.env.RECEIVER_SDK_LOADED, 'utf8').trim().split('\n').filter(Boolean).some(row => {
      const value = JSON.parse(row); return value.entry === __RECEIVER_SDK_ENTRY__ && value.executed === true
    })
  if (!loaded) throw Error('The selected native CommonJS SDK entry did not provide the running WSClient')
  appendFileSync(process.env.RECEIVER_SDK_LOADED, JSON.stringify({ entry: __RECEIVER_SDK_ENTRY__,
    sha256: createHash('sha256').update(readFileSync(__RECEIVER_SDK_ENTRY__)).digest('hex'), format: 'cjs', executed: true }) + '\n')
}

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
async function fixture(pongDelay = 0) {
  const wire = await feishuSocketTransport({ pongDelay }); cleanup.push(wire.close)
  // This is an original native endpoint value, with no documented minimum.
  wire.nativeConfig.PingInterval = 1
  const sdk = new WSClient({ appId: 'cli_0123456789abcdef', appSecret: 'fixture', httpInstance: wire.http,
    wsConfig: { pingTimeout: 15 }, handshakeTimeoutMs: 15000, loggerLevel: LoggerLevel.error })
  cleanup.push(() => sdk.close({ force: true }))
  await sdk.start({ eventDispatcher: new EventDispatcher({ loggerLevel: LoggerLevel.error }) })
  await vi.waitFor(() => expect(wire.pings.length).toBeGreaterThan(0), { interval: 20, timeout: 3000 })
  return { wire, sdk }
}

it('the native short interval cannot postpone the first unanswered ping recovery', async () => {
  const { wire, sdk } = await fixture()
  wire.state.pong = false
  wire.sockets[0]!.once('close', () => { wire.state.pong = true })
  await vi.waitFor(() => expect(wire.sockets).toHaveLength(2), { interval: 40, timeout: 18000 })
  await vi.waitFor(() => expect(sdk.getConnectionStatus().state).toBe('connected'), { interval: 40, timeout: 2000 })
  expect(wire.pings.length).toBeGreaterThan(10)
  expect(wire.acknowledgements).toEqual([])
}, 23000)

it('multiple short-interval pings retain an idle receiver with budget-contained slow inbound', async () => {
  const { wire, sdk } = await fixture(14000)
  await new Promise<void>(resolve => setTimeout(resolve, 17600))
  expect(wire.pings.length).toBeGreaterThan(16)
  expect(wire.sockets).toHaveLength(1); expect(wire.upgrades).toHaveLength(1)
  expect(sdk.getConnectionStatus().state).toBe('connected')
  expect(wire.acknowledgements).toEqual([])
}, 22000)
