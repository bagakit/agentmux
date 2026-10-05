import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { createDaemonChannel, exportPublicKey, generateKeyPair, type Transport } from '@agentmux/relay/e2ee'
import { connectAgentMuxRpc } from '../../core/dist/public-rpc-client.js'

// Real loopback WebSockets, compiled public SDK and production E2EE. This
// bounded consumer proves transport/error semantics, not a Native Agent turn.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function relay(accept: (socket: WebSocket) => void) {
  const key = generateKeyPair(), server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  server.on('connection', accept)
  cleanups.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Private Relay did not bind')
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: { v: 2, serverId: 'private-authority',
    daemonPublicKeyB64: exportPublicKey(key.publicKey), relay: { endpoint: `127.0.0.1:${address.port}`, useTls: false } } }, relayKeyPair: generateKeyPair() })
  cleanups.push(() => client.dispose())
  return { client, key }
}
function transport(socket: WebSocket): Transport {
  const port: Transport = { send: data => { socket.send(data) }, close: (code, reason) => socket.close(code === 1011 ? 4011 : code, reason), onmessage: null, onclose: null, onerror: null }
  socket.on('message', (data, isBinary) => port.onmessage?.({ data: isBinary ? Uint8Array.from(data as Buffer).buffer : data.toString(), isBinary }))
  socket.on('close', (code, reason) => port.onclose?.(code, reason.toString()))
  socket.on('error', error => port.onerror?.(error))
  return port
}

it('a generic carrier rejection retains unavailable semantics and never replays the call', async () => {
  let connections = 0
  const { client } = await relay(socket => { connections++; socket.close(4003, 'Admission temporarily unavailable') })
  await expect(client.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(connections).toBe(1)
  // Only a new explicit call creates another transport attempt.
  await expect(client.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(connections).toBe(2)
})

it('an encrypted Host error retains its capability code, independently of the carrier close', async () => {
  let requests = 0
  const f = await relay(socket => {
    const port = transport(socket)
    const channel = createDaemonChannel(port, f.key, { onmessage: data => {
      requests++
      const request = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
      void channel.then(value => value.send(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32000, message: 'Private Host credential denied', data: { code: 'AGENT_CAPABILITY_INVALID' } } })))
    } })
  })
  await expect(f.client.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(requests).toBe(1)
})

it('after a successful encrypted request, plaintext app traffic closes the channel without becoming an RPC frame', async () => {
  let requests = 0, closeCode: number | undefined
  const f = await relay(socket => {
    socket.on('close', code => { closeCode = code })
    void createDaemonChannel(transport(socket), f.key, { onmessage: () => {
      requests++
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'foreign', result: {} }))
    } })
  })
  const pending = expect(f.client.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await vi.waitFor(() => expect(closeCode).toBe(4001))
  await pending
  expect(requests).toBe(1)
})
