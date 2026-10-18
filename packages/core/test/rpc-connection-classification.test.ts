import { createServer as createUnixServer } from 'node:net'
import { createServer as createHttpServer, type RequestListener } from 'node:http'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { rpcTransportError } from '../src/rpc-transport-error.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { openAgentMuxRpcHttpRequest } from '../src/public-rpc-http.js'
import { forwardAgentMuxRpcStdio } from '../src/agentmux-rpc-stdio.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'amx-connection-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}
async function http(receive: RequestListener) {
  const server = createHttpServer(receive), sockets = new Set<import('node:net').Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`
}
async function client(endpoint: NonNullable<Parameters<typeof connectAgentMuxRpc>[0]>['endpoint']) {
  const value = await connectAgentMuxRpc({ endpoint })
  cleanups.push(() => value.dispose())
  return value
}

it('keeps typed authority and unknown outcomes while classifying only actual connection boundaries', () => {
  for (const code of ['CONTROL_PROTOCOL_ERROR', 'CONTROL_CANCELLED', 'AGENT_CAPABILITY_INVALID', 'STALE_AGENT_SESSION']) {
    const original = new AgentMuxError('Original owner failure', code, 'unknown')
    expect(rpcTransportError(original, 'connection')).toBe(original)
  }
  expect(rpcTransportError(new TypeError('Decode failure'))).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(rpcTransportError(Object.assign(new Error('Callback failure'), { code: 'ENOENT' }))).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(rpcTransportError(Object.assign(new Error('Owner absent'), { code: 'ENOENT' }), 'connection')).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(rpcTransportError(new Error('IO failure'), 'connection')).toMatchObject({ code: 'CONTROL_CONNECTION_FAILED' })
})

it('classifies real Unix connection failure separately from malformed wire data', async () => {
  const root = await directory(), loop = join(root, 'loop')
  await symlink('loop', loop)
  const unavailable = await client({ transport: 'unix', path: join(root, 'absent') })
  await expect(unavailable.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const broken = await client({ transport: 'unix', path: loop })
  await expect(broken.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'CONTROL_CONNECTION_FAILED' })
  const path = join(root, 'owner.sock')
  const server = createUnixServer(socket => socket.once('data', () => socket.end('{invalid}\n')))
  await new Promise<void>(resolve => server.listen(path, resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const malformed = await client({ transport: 'unix', path })
  await expect(malformed.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
})

it('preserves stdio owner-unavailable semantics at the actual Unix socket boundary', async () => {
  const root = await directory(), input = new PassThrough(), output = new PassThrough()
  try {
    await expect(forwardAgentMuxRpcStdio({ endpoint: { transport: 'unix', path: join(root, 'absent') }, input, output }))
      .rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  } finally { input.destroy(); output.destroy() }
})

it('does not replay an admitted mutation after its actual HTTP reply connection fails', async () => {
  const received: Array<{ method: string; params: { operationId: string } }> = []
  const url = await http((request, response) => {
    let body = ''
    request.on('data', data => { body += data })
    request.on('end', () => { received.push(JSON.parse(body)); response.destroy() })
  })
  const rpc = await client({ transport: 'http', url, token: 'fixture-token' })
  await expect(rpc.call('agent.open', { operationId: 'original-operation', content: { kind: 'agent-session', agentSessionId: 'original-session' },
    destination: { zoneId: 'original-zone', newTab: true }, focus: false })).rejects.toMatchObject({ code: 'CONTROL_CONNECTION_FAILED' })
  expect(received).toHaveLength(1)
  expect(received[0]).toMatchObject({ method: 'agent.open', params: { operationId: 'original-operation' } })
})

it.each(['application/json', 'text/event-stream'])('classifies a real interrupted HTTP %s body as connection failure', async contentType => {
  const url = await http((_request, response) => {
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': '1000' })
    response.write('{')
    setImmediate(() => response.destroy())
  })
  const rpc = await client({ transport: 'http', url, token: 'fixture-token' })
  await expect(rpc.call('space.ls', { target: {} })).rejects.toMatchObject({ code: 'CONTROL_CONNECTION_FAILED' })
})

it.each([
  ['malformed JSON', new TextEncoder().encode('{invalid}'), false],
  ['invalid UTF8', Uint8Array.of(0xff), false],
  ['consumer callback failure', new TextEncoder().encode('{}'), true]
] as const)('keeps %s at the HTTP protocol boundary', async (_name, bytes, callbackFails) => {
  const ended = Promise.withResolvers<Error | undefined>()
  const fetch: typeof globalThis.fetch = async () => new Response(bytes, { headers: { 'Content-Type': 'application/json' } })
  const reader = await openAgentMuxRpcHttpRequest({ url: 'https://rpc.invalid/', fetch },
    { jsonrpc: '2.0', id: 'original-reader', method: 'space.ls', params: { target: {} } },
    () => { if (callbackFails) throw Object.assign(new Error('Consumer failure'), { code: 'ENOENT' }) },
    ended.resolve, new AbortController().signal)
  cleanups.push(() => reader.dispose())
  await expect(ended.promise).resolves.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
})
