import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createHash } from 'node:crypto'
import { startLocalRelay, CLIENT_SOCKET_MAX_PAYLOAD, SERVER_SOCKET_MAX_PAYLOAD } from '../src/local-adapter.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const opened = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  socket.once('open', resolve); socket.once('error', reject)
})
const message = (socket: WebSocket) => new Promise<Buffer>((resolve, reject) => {
  socket.once('message', data => resolve(data as Buffer)); socket.once('error', reject)
})
const controlMessage = (socket: WebSocket, type: string) => new Promise<Record<string, string>>(resolve => {
  const listener = (data: Buffer) => {
    const value = JSON.parse(data.toString())
    if (value.type === type) { socket.off('message', listener); resolve(value) }
  }
  socket.on('message', listener)
})
async function setup() {
  const relay = await startLocalRelay({ serverId: 'role-limits', port: 0, route: () => {} })
  cleanup.push(() => relay.stop())
  const url = 'ws://127.0.0.1:' + relay.port + '/ws?v=2&serverId=role-limits'
  const control = relay.hostWebSocket(url + '&role=server')
  cleanup.push(() => control.terminate())
  const sync = controlMessage(control, 'sync')
  await opened(control); await sync
  const client = async () => {
    const connected = controlMessage(control, 'connected')
    const socket = new WebSocket(url + '&role=client')
    cleanup.push(() => socket.terminate())
    await opened(socket)
    const { connectionId } = await connected
    const data = async () => {
      const host = relay.hostWebSocket(url + '&role=server&connectionId=' + connectionId)
      cleanup.push(() => host.terminate())
      await opened(host)
      return host
    }
    return { socket, data }
  }
  return { client }
}

it.each([false, true])('rejects only the oversized client with data attached=%s and preserves peer requests', async attached => {
  const f = await setup()
  const healthy = await f.client(), invalid = await f.client()
  const healthyData = await healthy.data()
  if (attached) await invalid.data()
  // Before attachment the 8 MiB pending budget applies; after it, the client-role
  // frame limit applies. This does not derive authority from "pairing".
  const bytes = attached ? 16 * 1024 * 1024 + 1 : 8 * 1024 * 1024 + 1
  let closed = false
  invalid.socket.once('close', () => { closed = true })
  invalid.socket.send(Buffer.alloc(bytes))
  await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1500 })
  expect(invalid.socket.readyState).toBe(WebSocket.CLOSED)
  expect(healthy.socket.readyState).toBe(WebSocket.OPEN)
  const read = message(healthyData)
  healthy.socket.send('original peer still working')
  expect((await read).toString()).toBe('original peer still working')
  const reply = message(healthy.socket)
  healthyData.send('peer response')
  expect((await reply).toString()).toBe('peer response')
}, 10_000)

it('forwards every previously legal client frame at the 16 MiB boundary', async () => {
  const f = await setup(), { socket, data } = await f.client(), host = await data()
  const read = message(host)
  const original = Buffer.alloc(16 * 1024 * 1024, 0x4a)
  socket.send(original)
  const received = await read
  expect(received.byteLength).toBe(original.byteLength)
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  expect(sha(received)).toBe(sha(original))
  expect(socket.readyState).toBe(WebSocket.OPEN)
  expect(CLIENT_SOCKET_MAX_PAYLOAD).toBe(16 * 1024 * 1024)
  expect(SERVER_SOCKET_MAX_PAYLOAD).toBeGreaterThan(CLIENT_SOCKET_MAX_PAYLOAD)
}, 10_000)
