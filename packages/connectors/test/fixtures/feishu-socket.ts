import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:https'
import { vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { HttpInstance } from '@larksuiteoapi/node-sdk'
import { botOpenId, feishuPayload } from './feishu.js'

/** Actual TLS/WebSocket I/O and the locked SDK's native control frame; no lifecycle/status mocks. */
export async function feishuSocketTransport(options: { pongDelay?: number; handshakeDelay?: number; endpointCode?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'receiver-wire-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'ignore' })
  const key = await readFile(join(root, 'key.pem')), cert = await readFile(join(root, 'cert.pem'))
  // This isolated worker connects only to this ephemeral loopback certificate.
  // TLS trust is controlled I/O; handshake timing, WebSocket lifecycle and SDK frames stay real.
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@larksuiteoapi/node-sdk'))
  const protobuf = sdkRequire('protobufjs') as typeof import('protobufjs')
  const Frame = protobuf.parse('syntax="proto2"; message Header { required string key=1; required string value=2; } message Frame { required uint64 SeqID=1; required uint64 LogID=2; required int32 service=3; required int32 method=4; repeated Header headers=5; optional bytes payload=8; }').root.lookupType('Frame')
  const sockets: WebSocket[] = [], pings: WebSocket[] = [], acknowledgements: Array<{ code: number }> = [], upgrades: number[] = []
  const requests: Array<Parameters<HttpInstance['request']>[0]> = [], timers = new Set<ReturnType<typeof setTimeout>>()
  const pending = new Set<import('node:net').Socket>(), messages = new Map<string, ReturnType<typeof feishuPayload>>()
  const nativeConfig = { PingInterval: 16, ReconnectCount: 0, ReconnectInterval: 1, ReconnectNonce: 0 }
  const state = { pong: true, pongDelay: options.pongDelay ?? 0, handshakeDelay: options.handshakeDelay ?? 0,
    endpointCode: options.endpointCode ?? 0, nextEndpointCode: 0 }
  const later = (action: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); action() }, ms); timers.add(timer) }
  const encode = (method: number, headers: Array<{ key: string; value: string }>, payload?: unknown) =>
    Buffer.from(Frame.encode(Frame.create({ SeqID: 1, LogID: 1, service: 1, method, headers,
      ...(payload === undefined ? {} : { payload: Buffer.from(JSON.stringify(payload)) }) })).finish())
  const pong = (socket: WebSocket) => { if (socket.readyState === 1) socket.send(encode(0, [{ key: 'type', value: 'pong' }], nativeConfig)) }
  const server = createServer({ key, cert }), websocket = new WebSocketServer({ noServer: true })
  const tlsErrors: string[] = []
  server.on('tlsClientError', error => tlsErrors.push((error as NodeJS.ErrnoException).code ?? 'unknown'))
  server.on('connection', socket => { pending.add(socket); socket.once('close', () => pending.delete(socket)) })
  server.on('upgrade', (request, socket, head) => {
    upgrades.push(Date.now())
    const accept = () => { if (!socket.destroyed) websocket.handleUpgrade(request, socket, head, ws => websocket.emit('connection', ws, request)) }
    const delay = state.handshakeDelay; state.handshakeDelay = 0
    if (delay) later(accept, delay)
    else accept()
  })
  websocket.on('connection', socket => {
    sockets.push(socket)
    socket.on('message', buffer => {
      const frame = Frame.toObject(Frame.decode(buffer as Uint8Array), { defaults: true }) as { method: number; headers: Array<{ key: string; value: string }>; payload?: Buffer }
      if (frame.method === 0 && frame.headers.some(value => value.key === 'type' && value.value === 'ping')) {
        pings.push(socket)
        if (state.pong) later(() => pong(socket), state.pongDelay)
      } else if (frame.payload?.length) acknowledgements.push(JSON.parse(frame.payload.toString('utf8')))
    })
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Original fixture native endpoint absent')
  const request = async (input: Parameters<HttpInstance['request']>[0]) => {
    requests.push(input)
    if (input.url?.endsWith('/callback/ws/endpoint')) {
      const code = state.nextEndpointCode || state.endpointCode
      state.nextEndpointCode = 0
      return code ? { code, data: {}, msg: 'Private SDK error text is not a protocol code' }
        : { code: 0, data: { URL: 'wss://localhost:' + address.port + '/receiver?device_id=original&service_id=1', ClientConfig: nativeConfig } }
    }
    if (input.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: botOpenId } }
    if (input.url?.includes('/auth/v3/')) return { code: 0, tenant_access_token: 'fixture-tenant-access', app_access_token: 'fixture-app-access', expire: 3600 }
    const id = input.url?.split('/messages/')[1], original = id ? messages.get(id) : null
    if (original) return { code: 0, data: { items: [{ message_id: id, chat_id: 'original-room', create_time: '1' }] } }
    throw Error('Unexpected fixture native read')
  }
  let sequence = 0
  return { state, sockets, pings, acknowledgements, requests, nativeConfig, upgrades, tlsErrors,
    http: { request, post: (url: string, data: unknown) => request({ url, data }) } as unknown as HttpInstance,
    message(id: string, socket = sockets.at(-1)!) {
      const payload = messages.get(id) ?? feishuPayload({ message_id: id, content: JSON.stringify({ text: 'Original receiver input ' + id }) })
      payload.header.event_id = 'event-' + id; messages.set(id, payload)
      socket.send(encode(1, [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'wire-' + ++sequence },
        { key: 'sum', value: '1' }, { key: 'seq', value: '0' }], payload))
      return payload
    },
    pong,
    async close() {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.terminate()
      for (const socket of pending) socket.destroy()
      await new Promise<void>(resolve => websocket.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }
}
