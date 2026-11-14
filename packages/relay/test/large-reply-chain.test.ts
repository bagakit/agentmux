import { afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startLocalRelay, RELAY_MAX_RPC_FRAME_BYTES, SERVER_SOCKET_MAX_PAYLOAD } from '../src/local-adapter.js'
import { base64EncryptedWireByteLength } from '../src/encrypted-channel.js'
import { startRelayTransport, type RelayLogger } from '../src/server-transport.js'
import { exportPublicKey, generateKeyPair } from '../src/e2ee.js'
import { AgentMuxControlServer } from '../../core/src/public-rpc-server.js'
import { HostedRelayRpcPort } from '../../core/src/relay-hosted.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from '../../core/src/public-rpc-frame.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const logger: RelayLogger = { child: () => logger, info() {}, warn() {}, debug() {} }

// The controlled business owner returns bytes; Core owns actual framing, limits and errors.
// Host assembly below is the same local/transport/authenticated-frames path as apps/host/src/host.ts.
async function chain() {
  const relay = await startLocalRelay({ serverId: 'large-reply', port: 0, route: () => {} })
  cleanups.push(() => relay.stop())
  let bytes = 0, attached = 0, requestCount = 0
  const server = new AgentMuxControlServer({ hostedRuntime: () => ({
    call: async () => { requestCount++; return { value: bytes ? 'x'.repeat(bytes) : 'small reply' } }
  }) as never })
  cleanups.push(() => server.stop())
  const keys = generateKeyPair()
  const host = startRelayTransport({
    logger, relayEndpoint: '127.0.0.1:' + relay.port, relayUseTls: false,
    serverId: 'large-reply', daemonKeyPair: keys, createWebSocket: relay.hostWebSocket,
    attachSocket: async (socket, metadata) => {
      attached++
      if (!metadata?.peerPublicKeyB64) throw Error('Test peer was not cryptographically verified')
      const frames = server.openAuthenticatedFrames({
        authorization: { principal: { kind: 'device', id: metadata.peerPublicKeyB64 } },
        send: async frame => { await socket.send(JSON.stringify(frame)) },
        close: () => socket.close()
      })
      let queue = Promise.resolve()
      socket.on('message', data => {
        queue = queue.then(() => frames.receive(JSON.parse(typeof data === 'string' ? data
          : new TextDecoder().decode(data as ArrayBuffer))))
      })
      socket.once('close', () => frames.dispose())
    }
  })
  cleanups.push(() => host.stop())
  const sockets: WebSocket[] = []
  const port = new HostedRelayRpcPort({
    offer: { v: 2, serverId: 'large-reply', daemonPublicKeyB64: exportPublicKey(keys.publicKey),
      relay: { endpoint: '127.0.0.1:' + relay.port, useTls: false } },
    createWebSocket: url => {
      const socket = new WebSocket(url)
      sockets.push(socket)
      return socket as unknown as globalThis.WebSocket
    }
  })
  cleanups.push(() => port.dispose())
  const read = () => port.call('runtime.invoke', {
    consumerId: 'large-reply-reader', invocation: { method: 'readAgentSessions', args: [] }
  })
  return { read, sockets, bytes: (value: number) => { bytes = value },
    attached: () => attached, requests: () => requestCount }
}

it('a slow Hosted Relay reader receives one legal reply above 16 MiB and the next request on the same connection', async () => {
  expect(RELAY_MAX_RPC_FRAME_BYTES).toBe(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
  expect(SERVER_SOCKET_MAX_PAYLOAD).toBe(base64EncryptedWireByteLength(AGENTMUX_RPC_MAX_MESSAGE_BYTES))
  const f = await chain()
  expect(await f.read()).toEqual({ value: 'small reply' })
  const original = f.sockets[0]!
  original.pause()
  const bytes = 20 * 1024 * 1024
  expect(bytes).toBeGreaterThan(16 * 1024 * 1024)
  expect(bytes).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
  f.bytes(bytes)
  let settled = false
  const reading = f.read().then(result => { settled = true; return result })
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(settled).toBe(false)
  expect(original.readyState).toBe(WebSocket.OPEN)
  original.resume()
  expect(await reading).toEqual({ value: 'x'.repeat(bytes) })
  f.bytes(0)
  expect(await f.read()).toEqual({ value: 'small reply' })
  expect(f.attached()).toBe(1)
  expect(f.sockets).toHaveLength(1)
  expect(f.requests()).toBe(3)
}, 30_000)

it('actual Core rpcEncode rejects an over-64-MiB reply for its request and preserves the Hosted Relay carrier', async () => {
  const f = await chain()
  f.bytes(AGENTMUX_RPC_MAX_MESSAGE_BYTES + 1)
  await expect(f.read()).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(f.sockets[0]!.readyState).toBe(WebSocket.OPEN)
  f.bytes(0)
  expect(await f.read()).toEqual({ value: 'small reply' })
  expect(f.requests()).toBe(2)
  expect(f.attached()).toBe(1)
  expect(f.sockets).toHaveLength(1)
}, 30_000)
