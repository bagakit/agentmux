import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { isObjectId } from '@agentmux/identity'
import { startLocalRelay } from '../src/local-adapter.js'

const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close() })
async function open(socket: WebSocket) { clean.push(() => socket.terminate()); await once(socket, 'open'); return socket }
const text = (socket: WebSocket) => once(socket, 'message').then(([value]) => String(value))

it('local Relay allocates a shared pair ID, requires the original control credential and preserves exact two-way data routing', async () => {
  const relay = await startLocalRelay({ serverId: 'retained-server', port: 0, route: (_request, response) => response.end('private fixture') })
  clean.push(() => relay.stop())
  const base = 'ws://127.0.0.1:' + relay.port + '/ws?v=2&serverId=retained-server'
  const controlSocket = relay.hostWebSocket(base + '&role=server'), synced = text(controlSocket)
  const control = await open(controlSocket)
  expect(JSON.parse(await synced)).toEqual({ type: 'sync', connectionIds: [] })
  const connected = text(control), client = await open(new WebSocket(base + '&role=client', { headers: { 'user-agent': 'private-original-client' } }))
  const event = JSON.parse(await connected), connectionId = event.connectionId
  expect(event.type).toBe('connected'); expect(isObjectId(connectionId)).toBe(true)
  expect(relay.connectionInfo(connectionId)).toMatchObject({ address: '127.0.0.1', userAgent: 'private-original-client' })
  const foreign = new WebSocket(base + '&role=server&connectionId=' + connectionId)
  clean.push(() => foreign.terminate())
  const refused = await new Promise<number>((resolve, reject) => {
    foreign.once('unexpected-response', (_request, response) => { response.resume(); foreign.terminate(); resolve(response.statusCode!) })
    foreign.once('open', () => reject(new Error('A pair ID cannot authorize a data socket')))
    foreign.on('error', () => {})
  })
  expect(refused).toBe(403)
  const data = await open(relay.hostWebSocket(base + '&role=server&connectionId=' + connectionId))
  const input = text(data); client.send('original-client-frame'); expect(await input).toBe('original-client-frame')
  const output = text(client); data.send('original-server-frame'); expect(await output).toBe('original-server-frame')
  expect(relay.connectionInfo(connectionId)).toBeDefined()
})
