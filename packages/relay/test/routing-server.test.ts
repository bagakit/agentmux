import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { attachRelayRouter } from '../src/routing-server.js'
import { createPublisherAdmission, hashPublisherToken } from '../src/publisher-admission.js'
import { startRelayTransport, type RelayLogger } from '../src/server-transport.js'
import { createClientChannel, exportPublicKey, generateKeyPair, type Transport } from '../src/e2ee.js'
import { buildRelayWebSocketUrl } from '../src/daemon-endpoints.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const logger: RelayLogger = { child: () => logger, info() {}, warn() {}, debug() {} }
const credential = { alpha: 'original-alpha-credential', beta: 'original-beta-credential' }

async function fixture() {
  const http = createServer((_request, response) => response.end('private relay fixture'))
  const router = attachRelayRouter(http, { ...createPublisherAdmission(Object.entries(credential).map(([serverId, token]) => ({ serverId, tokenHash: hashPublisherToken(token) }))), publisherCollision: 'reject' })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw Error('Private Relay did not bind')
  cleanups.push(async () => { await router.stop(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) })
  const endpoint = '127.0.0.1:' + address.port
  const url = (serverId: string, role: 'server' | 'client', connectionId?: string) => buildRelayWebSocketUrl({ endpoint, useTls: false, serverId, role, ...(connectionId ? { connectionId } : {}) })
  const socket = (serverId: string, role: 'server' | 'client', token?: string, connectionId?: string) => {
    const ws = new WebSocket(url(serverId, role, connectionId), { ...(token ? { headers: { Authorization: 'Bearer ' + token } } : {}) })
    ws.on('error', () => {}); cleanups.push(() => ws.terminate()); return ws
  }
  const publisher = async (serverId: keyof typeof credential) => {
    const keys = generateKeyPair(), received: string[] = [], states: string[] = []
    const controller = startRelayTransport({ logger, relayEndpoint: endpoint, relayUseTls: false, serverId, daemonKeyPair: keys,
      createWebSocket: target => new WebSocket(target, { headers: { Authorization: 'Bearer ' + credential[serverId] } }),
      onState: state => { states.push(state) }, attachSocket: async (ws, metadata) => {
        if (!metadata?.peerPublicKeyB64) throw Error('Missing authenticated peer key')
        ws.on('message', async data => {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer)
          received.push(text); await ws.send(JSON.stringify({ serverId, request: JSON.parse(text) }))
        })
      },
    })
    cleanups.push(() => controller.stop())
    await vi.waitFor(() => expect(states).toContain('connected'))
    return { keys, received, controller }
  }
  const client = async (serverId: string, publicKey: Uint8Array) => {
    const ws = socket(serverId, 'client'), messages: string[] = [], opened = vi.fn()
    const transport: Transport = { send: data => { ws.send(data) }, close: (code, reason) => ws.close(code === 1000 || code && code >= 3000 && code <= 4999 ? code : 4001, reason), onmessage: null, onclose: null, onerror: null }
    ws.on('message', (data, binary) => transport.onmessage?.({ data: binary ? Uint8Array.from(data as Buffer).buffer : data.toString(), isBinary: binary }))
    ws.on('close', (code, reason) => transport.onclose?.(code, reason.toString()))
    await once(ws, 'open')
    const channel = await createClientChannel(transport, exportPublicKey(publicKey), { onopen: opened, onmessage: data => messages.push(typeof data === 'string' ? data : new TextDecoder().decode(data)), onclose() {}, onerror() {} })
    cleanups.push(() => channel.close())
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1))
    return { ws, channel, messages }
  }
  return { router, http, endpoint, url, socket, publisher, client }
}

const refused = (ws: WebSocket) => new Promise<number>((resolve, reject) => {
  ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!) })
  ws.once('open', () => { ws.terminate(); reject(Error('Unauthorized transport opened')) })
})

it('routes two real encrypted publishers independently and retains the other during one publisher failure', async () => {
  const f = await fixture(), a = await f.publisher('alpha'), b = await f.publisher('beta')
  const ac = await f.client('alpha', a.keys.publicKey), bc = await f.client('beta', b.keys.publicKey)
  await ac.channel.send(JSON.stringify({ id: 1, content: 'alpha original' }))
  await bc.channel.send(JSON.stringify({ id: 2, content: 'beta original' }))
  await vi.waitFor(() => {
    expect(ac.messages.map(value => JSON.parse(value))).toEqual([{ serverId: 'alpha', request: { id: 1, content: 'alpha original' } }])
    expect(bc.messages.map(value => JSON.parse(value))).toEqual([{ serverId: 'beta', request: { id: 2, content: 'beta original' } }])
  })
  await a.controller.stop()
  await vi.waitFor(() => expect(ac.ws.readyState).toBe(WebSocket.CLOSED))
  await bc.channel.send(JSON.stringify({ id: 3, content: 'beta still available' }))
  await vi.waitFor(() => expect(bc.messages.map(value => JSON.parse(value)).at(-1)).toEqual({ serverId: 'beta', request: { id: 3, content: 'beta still available' } }))
  expect(b.received.map(value => JSON.parse(value).content)).toEqual(['beta original', 'beta still available'])
})

it('requires the exact publisher credential and refuses duplicate active control without displacing the original', async () => {
  const f = await fixture(), a = await f.publisher('alpha')
  await expect(refused(f.socket('alpha', 'server', credential.beta))).resolves.toBe(403)
  await expect(refused(f.socket('unregistered', 'server', credential.alpha))).resolves.toBe(403)
  await expect(refused(f.socket('alpha', 'server'))).resolves.toBe(403)
  await expect(refused(f.socket('alpha', 'server', credential.alpha))).resolves.toBe(409)
  const client = await f.client('alpha', a.keys.publicKey)
  await client.channel.send(JSON.stringify({ id: 4 }))
  await vi.waitFor(() => expect(client.messages.map(value => JSON.parse(value))).toEqual([{ serverId: 'alpha', request: { id: 4 } }]))
})

it('a data route belongs only to its original server and an active data socket is not replaced', async () => {
  const f = await fixture()
  const controlA = f.socket('alpha', 'server', credential.alpha), syncA = once(controlA, 'message')
  await once(controlA, 'open'); expect(JSON.parse(String((await syncA)[0])).type).toBe('sync')
  const controlB = f.socket('beta', 'server', credential.beta), syncB = once(controlB, 'message')
  await once(controlB, 'open'); await syncB
  const connected = once(controlA, 'message'), client = f.socket('alpha', 'client')
  await once(client, 'open')
  const { connectionId } = JSON.parse(String((await connected)[0]))
  await expect(refused(f.socket('beta', 'server', credential.beta, connectionId))).resolves.toBe(403)
  const data = f.socket('alpha', 'server', credential.alpha, connectionId)
  await once(data, 'open')
  await expect(refused(f.socket('alpha', 'server', credential.alpha, connectionId))).resolves.toBe(409)
  const read = once(data, 'message'); client.send('original route remains available')
  expect(String((await read)[0])).toBe('original route remains available')
})
