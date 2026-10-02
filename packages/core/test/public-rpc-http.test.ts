import { fixturePath } from './helpers/fixture-values.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc as connectSource } from '../src/public-rpc-client.js'
import { connectAgentMuxRpc as connectBuilt } from '../dist/public-rpc-client.js'
import { AgentMuxError, AgentMuxRpcLines, AGENTMUX_RPC_MAX_MESSAGE_BYTES,
  openAgentMuxRpcHttpRequest, parseRpcRequest, parseRpcResponse, rpcResponseError, rpcEncode,
  type JSONRPCRequest } from '../src/public-rpc-http.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const request: JSONRPCRequest = { jsonrpc: '2.0', id: 'shared-reader', method: 'settings.inspect', params: {} }
const settings = { entries: [{ key: 'shared', kind: 'string', value: '字节保持', default: '字节保持' }], partial: true }
async function http(receive: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(receive), sockets = new Set<import('node:net').Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`
}
async function collect(url: string, options: Parameters<typeof openAgentMuxRpcHttpRequest>[0] = { url }) {
  const frames: unknown[] = [], ended = Promise.withResolvers<Error | undefined>()
  const reader = await openAgentMuxRpcHttpRequest(options, request, frame => frames.push(frame), ended.resolve, new AbortController().signal)
  cleanups.push(() => reader.dispose())
  return { frames, error: await ended.promise }
}
const sse = (frame: unknown) => `data: ${JSON.stringify(frame)}\n\n`

it.each(['\n\n', '\r\n\r\n'])('preserves an exact-budget event when the separator %j arrives in separate chunks', async separator => {
  const frame = { jsonrpc: '2.0', id: request.id, result: '' }
  const overhead = Buffer.byteLength(`data: ${JSON.stringify(frame)}`)
  frame.result = 'x'.repeat(AGENTMUX_RPC_MAX_MESSAGE_BYTES - overhead)
  const event = new TextEncoder().encode(`data: ${JSON.stringify(frame)}`)
  expect(event.byteLength).toBe(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
  // The same complete event and the fragmented event must deliver the same
  // original frame. Only transport chunk boundaries change between readers.
  for (const fragmented of [false, true]) {
    const chunks = fragmented
      ? [event, ...[...separator].map(character => Uint8Array.of(character.charCodeAt(0)))]
      : [new TextEncoder().encode(`data: ${JSON.stringify(frame)}${separator}`)]
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() }
    }), { headers: { 'Content-Type': 'text/event-stream' } })
    const result = await collect('https://private.invalid/rpc', { url: 'https://private.invalid/rpc', fetch })
    expect(result.error).toBeUndefined()
    expect(result.frames).toEqual([frame])
    expect(parseRpcResponse(result.frames[0]).id).toBe(request.id)
  }
})

it.each([['source', connectSource], ['compiled', connectBuilt]] as const)('uses the shared HTTP leaf from the real %s Node client and preserves business failures', async (_name, connect) => {
  const root = await mkdtemp(fixturePath("tmp/amx-pure-http-"))
  let fail = false
  const owner = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [],
    http: { host: '127.0.0.1', port: 0, token: 'actual-shared-http' },
    execute: async () => {
      if (fail) throw Object.assign(new AgentMuxError('Original decision.', 'AGENT_PROMPT_STATE_UNCONFIRMED', 'not_applied'),
        { details: { original: true }, candidates: [{ unchanged: true }] })
      return { operation: 'settings.get', ...settings }
    } })
  cleanups.push(async () => { await owner.stop(); await rm(root, { recursive: true, force: true }) })
  await owner.start()
  const client = await connect({ endpoint: { transport: 'http', url: `http://127.0.0.1:${owner.httpAddress!.port}/`, token: 'actual-shared-http' } })
  cleanups.push(() => client.dispose())
  await expect(client.call('settings.inspect', {})).resolves.toEqual(settings)
  fail = true
  await expect(client.call('settings.inspect', {})).rejects.toMatchObject({ code: 'AGENT_PROMPT_STATE_UNCONFIRMED',
    message: 'Original decision.', detail: 'not_applied', details: { original: true }, candidates: [{ unchanged: true }] })
})

it('passes cookie credentials and a request-local native fetch through real HTTP without changing global fetch', async () => {
  const original = globalThis.fetch, observed: unknown[] = []
  const url = await http(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString('utf8')
    observed.push({ cookie: req.headers.cookie, body: JSON.parse(body), type: req.headers['content-type'] })
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: settings }))
  })
  const nativeFetch: typeof fetch = (input, init) => {
    expect(init?.credentials).toBe('include'); expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers); headers.set('Cookie', 'approved=original-device')
    return original(input, { ...init, headers })
  }
  const result = await collect(url, { url, credentials: 'include', fetch: nativeFetch })
  expect(result.error).toBeUndefined(); expect(result.frames).toEqual([{ jsonrpc: '2.0', id: request.id, result: settings }])
  expect(observed).toEqual([{ cookie: 'approved=original-device', body: request, type: 'application/json' }])
  expect(globalThis.fetch).toBe(original)
})

it('decodes nonempty ordered SSE and UTF-8 split into single-byte transport chunks with the same strict envelope parser', async () => {
  const opening = { jsonrpc: '2.0', id: request.id, result: { subscriptionId: 'actual-reader', initial: { text: '最初' } } }
  const notices = ['第一', '第二'].map((text, index) => ({ jsonrpc: '2.0', method: 'system.subscription.event',
    params: { subscriptionId: 'actual-reader', sequence: index + 1, text } }))
  const url = await http((_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end([opening, ...notices].map(sse).join('').replaceAll('\n', '\r\n')) })
  let chunks = 0
  const nativeFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    const body = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(value, controller) { for (const byte of value) { chunks++; controller.enqueue(Uint8Array.of(byte)) } }
    }))
    return new Response(body, { status: response.status, headers: response.headers })
  }
  const result = await collect(url, { url, fetch: nativeFetch })
  expect(result.error).toBeUndefined(); expect(chunks).toBeGreaterThan(3)
  expect(result.frames).toEqual([opening, ...notices])
  expect(parseRpcResponse(result.frames[0])).toEqual(opening)
  expect(result.frames.slice(1).map(parseRpcRequest)).toEqual(notices)
})

it('preserves a 16 MiB UTF-8 SSE reply through fragmented real HTTP chunks', async () => {
  const frame = { jsonrpc: '2.0', id: request.id, result: '字节'.repeat(2_800_000) }
  const body = sse(frame).replaceAll('\n', '\r\n')
  expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024 * 1024)
  const url = await http((_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(body) })
  let chunks = 0
  const nativeFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    const split = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(value, controller) {
        for (let offset = 0; offset < value.byteLength; offset += 8_191) {
          chunks++; controller.enqueue(value.subarray(offset, offset + 8_191))
        }
      }
    }))
    return new Response(split, { status: response.status, headers: response.headers })
  }
  const result = await collect(url, { url, fetch: nativeFetch })
  expect(chunks).toBeGreaterThan(1_000)
  expect(result.error).toBeUndefined(); expect(result.frames).toEqual([frame])
}, 15_000)

it('preserves mixed SSE separators, multiline data and adjacent events across tiny HTTP chunks', async () => {
  const frames = ['第一', '第二', '第三'].map((result, index) => ({ jsonrpc: '2.0', id: index, result }))
  const body = 'data: ' + JSON.stringify(frames[0]) + '\r\n\n' +
    'data: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":"第二"}\n\r\n' +
    'data: ' + JSON.stringify(frames[2]) + '\r\n\r\n'
  const url = await http((_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(body) })
  const nativeFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    const split = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(value, controller) {
        for (let offset = 0; offset < value.byteLength; offset += 3) controller.enqueue(value.subarray(offset, offset + 3))
      }
    }))
    return new Response(split, { status: response.status, headers: response.headers })
  }
  const result = await collect(url, { url, fetch: nativeFetch })
  expect(result.error).toBeUndefined(); expect(result.frames).toEqual(frames)
})

it('stops inside a notification callback without draining later frames or closing another real reader', async () => {
  const frames = [1, 2, 3].map(sequence => ({ jsonrpc: '2.0', method: 'system.subscription.event', params: { sequence } }))
  const url = await http((_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(frames.map(sse).join('')) })
  const controller = new AbortController(), seen: unknown[] = [], ended = Promise.withResolvers<Error | undefined>()
  const reader = await openAgentMuxRpcHttpRequest({ url }, request, frame => { seen.push(frame); controller.abort() }, ended.resolve, controller.signal)
  cleanups.push(() => reader.dispose())
  expect(await ended.promise).toMatchObject({ code: 'CONTROL_CANCELLED' })
  const other = await collect(url)
  expect(other.error).toBeUndefined(); expect(other.frames).toEqual(frames)
  expect(seen).toEqual([frames[0]])
})

it('cancels before fetching and while awaiting the actual HTTP response', async () => {
  const before = new AbortController(); before.abort()
  const fetcher = vi.fn<typeof fetch>(), noFrame = vi.fn(), noEnd = vi.fn()
  await expect(openAgentMuxRpcHttpRequest({ url: 'http://127.0.0.1/', fetch: fetcher }, request, noFrame, noEnd, before.signal))
    .rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect(fetcher).not.toHaveBeenCalled()
  const entered = Promise.withResolvers<void>(), url = await http(() => entered.resolve())
  const waiting = new AbortController()
  const opening = openAgentMuxRpcHttpRequest({ url }, request, noFrame, noEnd, waiting.signal)
  await entered.promise; waiting.abort()
  await expect(opening).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect(noFrame).not.toHaveBeenCalled(); expect(noEnd).not.toHaveBeenCalled()
})

it.each([
  ['incomplete SSE', 'text/event-stream', 'data: {"jsonrpc":"2.0"}', 'CONTROL_PROTOCOL_ERROR'],
  ['invalid JSON', 'application/json', '{invalid}', 'CONTROL_PROTOCOL_ERROR'],
  ['invalid UTF-8 SSE', 'text/event-stream', Uint8Array.from([100, 97, 116, 97, 58, 32, 0xc3, 0x28, 10, 10]), 'CONTROL_PROTOCOL_ERROR'],
  ['oversized JSON', 'application/json', JSON.stringify('x'.repeat(AGENTMUX_RPC_MAX_MESSAGE_BYTES)), 'CONTROL_PROTOCOL_ERROR'],
  ['oversized SSE', 'text/event-stream', sse({ jsonrpc: '2.0', id: request.id, result: 'x'.repeat(AGENTMUX_RPC_MAX_MESSAGE_BYTES) }), 'CONTROL_PROTOCOL_ERROR'],
  ['unexpected type', 'text/plain', '{}', 'CONTROL_PROTOCOL_ERROR']
] as const)('rejects actual %s without delivering a business frame', async (_name, type, body, code) => {
  const url = await http((_req, res) => { res.setHeader('Content-Type', type); res.end(body) })
  const result = await collect(url)
  expect(result.error).toMatchObject({ code }); expect(result.frames).toEqual([])
}, 15_000)

it('keeps response identity and strict envelope checks in the real Node HTTP consumer', async () => {
  let response: unknown = { jsonrpc: '2.0', id: 'wrong-correlation', result: settings }
  const url = await http((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response)) })
  const client = await connectSource({ endpoint: { transport: 'http', url, token: 'client-owned' } })
  cleanups.push(() => client.dispose())
  await expect(client.call('settings.inspect', {})).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  response = { jsonrpc: '2.0', id: 'irrelevant', operation: 'settings.get', result: settings }
  await expect(client.call('settings.inspect', {})).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  const failure = rpcResponseError(parseRpcResponse({ jsonrpc: '2.0', id: 'error', error: {
    code: -32000, message: 'Retained original failure.', data: { code: 'AGENT_PROMPT_STATE_UNCONFIRMED', detail: 'unknown', details: { kept: true }, candidates: ['original'] }
  } }))
  expect(failure).toMatchObject({ detail: 'unknown', details: { kept: true }, candidates: ['original'] })
})

it('shares one bounded line decoder across fragmented UTF-8 and complete adjacent frames', () => {
  const decoder = new AgentMuxRpcLines(), values: unknown[] = [], frame = { jsonrpc: '2.0', id: 'line', result: '字节' }
  const bytes = new TextEncoder().encode(rpcEncode(frame) + rpcEncode(frame))
  for (const byte of bytes) decoder.accept(Uint8Array.of(byte), value => values.push(value))
  decoder.end(); expect(values).toEqual([frame, frame])
  const incomplete = new AgentMuxRpcLines(); incomplete.accept(Uint8Array.of(123), () => {})
  expect(() => incomplete.end()).toThrow('incomplete frame')
  expect(() => new AgentMuxRpcLines().accept(new Uint8Array(AGENTMUX_RPC_MAX_MESSAGE_BYTES + 1), () => {})).toThrow('bounded frame budget')
})

it('preserves a legitimate 16 MiB message through encoding and fragmented shared decoding', () => {
  const frame = { jsonrpc: '2.0', id: 'retained-large-message', result: '' }
  const originalBytes = 16 * 1024 * 1024
  frame.result = 'x'.repeat(originalBytes - Buffer.byteLength(JSON.stringify(frame)))
  const bytes = new TextEncoder().encode(rpcEncode(frame))
  expect(bytes.byteLength - 1).toBe(originalBytes)
  const decoder = new AgentMuxRpcLines(), values: unknown[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += 65_536) decoder.accept(bytes.subarray(offset, offset + 65_536), value => values.push(value))
  decoder.end()
  expect(values).toEqual([frame])
}, 15_000)

it('accepts the exact shared frame budget and rejects one extra byte in both directions', () => {
  const frame = { jsonrpc: '2.0', id: 'boundary', result: '' }
  frame.result = 'x'.repeat(AGENTMUX_RPC_MAX_MESSAGE_BYTES - Buffer.byteLength(JSON.stringify(frame)))
  const encoded = rpcEncode(frame), bytes = new TextEncoder().encode(encoded)
  expect(bytes.byteLength - 1).toBe(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
  const decoder = new AgentMuxRpcLines(), values: unknown[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += 65_536) decoder.accept(bytes.subarray(offset, offset + 65_536), value => values.push(value))
  decoder.end()
  expect(values).toEqual([frame])
  expect(() => rpcEncode({ ...frame, result: frame.result + 'x' })).toThrow('bounded frame budget')
  const oversized = new AgentMuxRpcLines(), consume = vi.fn()
  oversized.accept(new Uint8Array(AGENTMUX_RPC_MAX_MESSAGE_BYTES), consume)
  expect(() => oversized.accept(Uint8Array.of(120), consume)).toThrow('bounded frame budget')
  expect(consume).not.toHaveBeenCalled()
}, 15_000)

it('bundles the actual exported HTTP leaf for browsers with a nonempty graph and no Node imports', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  expect(pkg.exports['./public-rpc-http']).toEqual({ types: './dist/public-rpc-http.d.ts', import: './dist/public-rpc-http.js' })
  const result = await build({ entryPoints: [new URL('../' + pkg.exports['./public-rpc-http'].import, import.meta.url).pathname],
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' })
  const inputs = Object.keys(result.metafile!.inputs)
  expect(inputs.length).toBeGreaterThan(2)
  expect(inputs.some(input => input.endsWith('public-rpc-http.js'))).toBe(true)
  expect(inputs.some(input => input.endsWith('public-rpc-frame.js'))).toBe(true)
  expect(inputs.some(input => input.endsWith('hosted-value.js'))).toBe(true)
  const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports.map(item => item.path))
  expect(imports.length).toBeGreaterThan(0)
  expect(imports.filter(path => path.startsWith('node:'))).toEqual([])
  expect(result.outputFiles[0]!.contents.byteLength).toBeGreaterThan(100)
  const browserModule = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.contents).toString('base64')}`)
  expect(typeof browserModule.encodeHostedValue).toBe('function')
  expect(typeof browserModule.decodeHostedValue).toBe('function')
  const original = { env: { signal: 'keep-me', $agentmuxValue: 'bytes', data: 'ordinary' },
    bytes: Uint8Array.from([0, 232, 156, 173, 255]), tuple: ['scope', undefined] }
  const wireValue = JSON.parse(JSON.stringify(browserModule.encodeHostedValue(original)))
  expect(browserModule.decodeHostedValue(wireValue)).toEqual(original)
})
