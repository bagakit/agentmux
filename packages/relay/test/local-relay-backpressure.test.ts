import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { startLocalRelay, RELAY_FORWARD_HIGH_WATER_MARK } from '../src/local-adapter.js'

const MiB = 1024 * 1024
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
const control = (ws: WebSocket, type: string) => new Promise<Record<string, unknown>>(resolve => {
  const listener = (data: Buffer) => { const message = JSON.parse(data.toString()); if (message.type === type) { ws.off('message', listener); resolve(message) } }
  ws.on('message', listener)
})

/** Host control and data sockets plus one client, through the same local Relay entry the Host uses. */
async function paired() {
  const relay = await startLocalRelay({ serverId: 'backpressure', port: 0, route: () => {} })
  cleanups.push(() => relay.stop())
  const url = `ws://127.0.0.1:${relay.port}/ws?v=2&serverId=backpressure`
  const host = relay.hostWebSocket(`${url}&role=server`)
  cleanups.push(() => host.terminate())
  const synced = control(host, 'sync')
  await opened(host); await synced
  const connected = control(host, 'connected')
  const client = new WebSocket(`${url}&role=client`)
  cleanups.push(() => client.terminate())
  await opened(client)
  const data = relay.hostWebSocket(`${url}&role=server&connectionId=${String((await connected).connectionId)}`)
  cleanups.push(() => data.terminate())
  await opened(data)
  return { client, data }
}

it('forwards small frames in both directions', async () => {
  const { client, data } = await paired()
  const toClient = new Promise<string>(resolve => client.once('message', value => resolve(value.toString())))
  const toHost = new Promise<string>(resolve => data.once('message', value => resolve(value.toString())))
  data.send('from host'); client.send('from client')
  expect(await toClient).toBe('from host')
  expect(await toHost).toBe('from client')
})

it('a paused reader pauses its source instead of closing, and receives everything in order after resuming', async () => {
  const { client, data } = await paired()
  const closes: number[] = [], received: number[] = []
  client.on('close', code => closes.push(code))
  client.on('message', value => received.push((value as Buffer)[0]!))
  client.pause()

  const COUNT = 64, frame = (index: number) => Buffer.alloc(MiB, index)
  expect(COUNT * MiB).toBeGreaterThan(2 * RELAY_FORWARD_HIGH_WATER_MARK)
  for (let index = 0; index < COUNT; index++) data.send(frame(index))

  // The Relay stops reading the Host data socket, so the remainder stays queued at the Host.
  await new Promise(resolve => setTimeout(resolve, 750))
  expect(data.bufferedAmount).toBeGreaterThan(0)
  expect(data.readyState).toBe(WebSocket.OPEN)
  expect(client.readyState).toBe(WebSocket.OPEN)

  client.resume()
  await vi.waitFor(() => expect(received).toHaveLength(COUNT), { timeout: 15_000, interval: 50 })
  expect(received).toEqual(Array.from({ length: COUNT }, (_, index) => index))
  expect(closes).toEqual([])

  const after = new Promise<string>(resolve => client.once('message', value => resolve(value.toString())))
  data.send('after the burst')
  expect(await after).toBe('after the burst')
}, 30_000)

it('a bootstrap burst above the old 8 MiB reader budget arrives in order with its trailing sentinel', async () => {
  const { client, data } = await paired()
  const received: Buffer[] = [], closes: number[] = []
  client.on('message', value => received.push(value as Buffer))
  client.on('close', code => closes.push(code))
  const chunk = Buffer.alloc(48 * 1024, 0x42)
  for (let index = 0; index < 200; index++) data.send(chunk)
  data.send(JSON.stringify({ type: 'sentinel' }))
  await vi.waitFor(() => expect(received).toHaveLength(201), { timeout: 10_000, interval: 50 })
  expect(JSON.parse(received.at(-1)!.toString())).toEqual({ type: 'sentinel' })
  expect(closes).toEqual([])
}, 15_000)
