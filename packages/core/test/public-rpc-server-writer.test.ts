import { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import type { Server, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer as SourceServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc as sourceConnect } from '../src/public-rpc-client.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, type AgentMuxRpcFrame } from '../src/public-rpc-frame.js'
import type { AgentMuxRpcConnection } from '../src/public-rpc-wire.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const AgentMuxControlServer: typeof SourceServer = process.env.AGENTMUX_TEST_RPC_SERVER_ENTRY
  ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_RPC_SERVER_ENTRY).href)).AgentMuxControlServer : SourceServer
const connectAgentMuxRpc: typeof sourceConnect = process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY
  ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY).href)).connectAgentMuxRpc : sourceConnect
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

class SlowSocket extends Duplex {
  frames: any[] = []
  held: Array<(error?: Error | null) => void> = []
  constructor() { super({ writableHighWaterMark: 1 }) }
  setTimeout() { return this }
  _read() {}
  write(chunk: any, ...args: any[]): boolean { this.frames.push(JSON.parse(String(chunk))); return super.write(chunk, ...args) }
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { this.held.push(done) }
  release() { this.held.shift()?.() }
}
function controlled() {
  const owner = new AgentMuxControlServer({ coreClients: () => [] })
  const inner = owner as unknown as { accept(socket: SlowSocket): void; connection: (...args: any[]) => { context: AgentMuxRpcConnection } }
  const original = inner.connection.bind(owner)
  let context!: AgentMuxRpcConnection
  vi.spyOn(inner, 'connection').mockImplementation((...args) => { const value = original(...args); context = value.context; return value })
  const socket = new SlowSocket(); inner.accept(socket)
  cleanup.push(() => owner.stop())
  return { socket, context, owner }
}
const response = (id: number): AgentMuxRpcFrame => ({ jsonrpc: '2.0', id, result: { body: '原文😀'.repeat(8192), ordinal: id } })

it('the actual server writer waits once for a long burst and preserves send order without aggregate refusal', async () => {
  const { socket, context } = controlled(), settled: number[] = []
  const sends = Array.from({ length: 80 }, (_, id) => Promise.resolve(context.send(response(id))).then(() => settled.push(id)))
  await tick()
  expect(socket.frames.map(frame => frame.id)).toEqual([0])
  expect(settled).toEqual([])
  expect(socket.listenerCount('drain')).toBe(1)
  // A residual physical backlog is not this next legal frame's size. No 64MiB allocation needed.
  Object.defineProperty(socket, 'writableLength', { get: () => AGENTMUX_RPC_MAX_MESSAGE_BYTES })
  for (let id = 0; id < sends.length; id++) {
    socket.release(); await tick()
    expect(settled).toEqual(Array.from({ length: id + 1 }, (_, index) => index))
    expect(socket.destroyed).toBe(false)
    expect(socket.frames.length).toBe(Math.min(id + 2, sends.length))
    expect(socket.listenerCount('drain')).toBe(1)
  }
  await Promise.all(sends)
  expect(socket.frames).toEqual(Array.from({ length: sends.length }, (_, id) => response(id)))
})

it.each(['close', 'error', 'dispose'] as const)('%s releases current and queued server sends once, without late writes', async failure => {
  const { socket, context, owner } = controlled(), settled: number[] = []
  const sends = Array.from({ length: 20 }, (_, id) => Promise.resolve(context.send(response(id))).then(() => settled.push(id)))
  await tick(); expect(socket.frames).toHaveLength(1)
  if (failure === 'dispose') await owner.stop()
  else socket.destroy(failure === 'error' ? new Error('private write failure') : undefined)
  await tick()
  expect(settled).toHaveLength(20); expect(new Set(settled).size).toBe(20)
  expect(socket.listenerCount('drain')).toBe(0)
  await Promise.all(sends); socket.release(); await tick()
  await context.send(response(99))
  expect(socket.frames).toHaveLength(1)
})

it('a malformed request sends its final parse error after already admitted replies have drained', async () => {
  const { socket, context } = controlled()
  const first = context.send(response(1)), second = context.send(response(2))
  socket.emit('data', Buffer.from('{not-json}\n'))
  await tick(); expect(socket.frames.map(frame => frame.id)).toEqual([1]); expect(socket.writableEnded).toBe(false)
  socket.release(); await tick(); expect(socket.frames.map(frame => frame.id)).toEqual([1, 2])
  socket.release(); await tick()
  expect(socket.frames[2]).toMatchObject({ id: null, error: { code: -32700 } })
  expect(socket.writableEnded).toBe(false)
  socket.release(); await tick(); await first; await second
  expect(socket.writableEnded).toBe(true); expect(socket.listenerCount('drain')).toBe(0)
  await context.send(response(3)); expect(socket.frames).toHaveLength(3)
})

async function endpoint() {
  const root = await mkdtemp(join(tmpdir(), 'amx-server-writer-')), path = join(root, 'owner.sock')
  let snapshots = 0
  const pushes = new Map<string, (event: { sequence: number; event: unknown }) => void>()
  const disposed = new Map<string, number>()
  const owner = new AgentMuxControlServer({ socketPath: path, coreClients: () => [],
    http: { host: '127.0.0.1', port: 0, token: 'private-writer' },
    snapshot: async () => ({ topics: [{ id: 'topic', topicId: 'topic', workspaceId: 'scratch', hostId: 'local', path: root,
      spaceId: 'space', kind: 'topic', directoryPath: 'topic', topicPath: 'topic/Topic.md', title: 'Topic',
      summary: `${snapshots++}:` + '原文😀'.repeat(8192), collaborators: [] }] }),
    subscribeBrowserOperation: async (request, push) => {
      pushes.set(request.operationId, push)
      return { runOperation: null, gap: null, dispose: () => { disposed.set(request.operationId, (disposed.get(request.operationId) ?? 0) + 1) } }
    }
  })
  await owner.start(); cleanup.push(async () => { await owner.stop(); await rm(root, { recursive: true, force: true }) })
  const inner = owner as unknown as { sockets: Set<Socket>; httpServer: Server }
  return { owner, inner, root, path, pushes, disposed }
}

it('real Unix public calls share the stalled writer, retain complete replies, and cancel only the original reader', async () => {
  const f = await endpoint(), client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.path } })
  cleanup.push(() => client.dispose())
  const leftEvents: number[] = [], rightEvents: number[] = []
  const left = await client.subscribe('browser.follow', { operationId: 'left' }, { onInitial() {}, onEvent: event => { if (event.type === 'progress') leftEvents.push(event.data.sequence) } })
  const right = await client.subscribe('browser.follow', { operationId: 'right' }, { onInitial() {}, onEvent: event => { if (event.type === 'progress') rightEvents.push(event.data.sequence) } })
  const socket = [...f.inner.sockets][0]!
  socket.cork()
  const replies = Array.from({ length: 20 }, () => client.call('app.snapshot', { include: ['topics'] }))
  for (const reply of replies) void reply.catch(() => {})
  await vi.waitFor(() => expect(socket.writableLength).toBeGreaterThan(65_536))
  expect(socket.listenerCount('drain')).toBe(1)
  expect(socket.writableLength).toBeLessThan(200_000)
  const inspection = await runCompiledObjectCli(['--endpoint', `unix:${f.path}`, 'system', 'endpoint', '--inspect'], objectCliEnvironment(f.root))
  expect(inspection.code).toBe(0)
  expect(JSON.parse(inspection.stdout).result.endpoint).toEqual({ transport: 'unix', path: f.path })
  f.pushes.get('left')!({ sequence: 1, event: { content: 'already admitted before cancellation' } })
  const cancel = left.dispose()
  await vi.waitFor(() => expect(f.disposed.get('left')).toBe(1))
  expect(f.disposed.get('right')).toBeUndefined()
  f.pushes.get('right')!({ sequence: 1, event: { content: 'original event' } })
  socket.uncork()
  const results = await Promise.all(replies); await cancel
  expect(results.map(result => result.topics[0]!.summary)).toEqual(Array.from({ length: 20 }, (_, index) => `${index}:` + '原文😀'.repeat(8192)))
  await vi.waitFor(() => expect(rightEvents).toEqual([1])); expect(leftEvents).toEqual([])
  expect((await client.call('system.endpoint', {})).endpoint).toEqual({ transport: 'unix', path: f.path })
  await right.dispose(); await vi.waitFor(() => expect(f.disposed.get('right')).toBe(1))
  expect(socket.destroyed).toBe(false)
})

it('real HTTP SSE backpressure preserves original events and isolates another response, then releases on close', async () => {
  const f = await endpoint(), responses: ServerResponse[] = []
  f.inner.httpServer.prependListener('request', (_request, response) => responses.push(response))
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${f.owner.httpAddress!.port}/`, token: 'private-writer' } })
  cleanup.push(() => client.dispose())
  const events: number[] = [], endings: unknown[] = []
  const reader = await client.subscribe('browser.follow', { operationId: 'sse' }, { onInitial() {}, onEnd: error => endings.push(error), onEvent: event => { if (event.type === 'progress') events.push(event.data.sequence) } })
  const response = responses.at(-1)!
  const socket = response.socket!
  socket.cork()
  for (let sequence = 1; sequence <= 20; sequence++) f.pushes.get('sse')!({ sequence, event: { content: '原文😀'.repeat(8192) } })
  await tick()
  expect(response.listenerCount('drain')).toBe(1)
  expect(response.writableLength).toBeLessThan(200_000)
  expect((await client.call('system.endpoint', {})).endpoint).toEqual({ transport: 'unix', path: f.path })
  socket.uncork(); await vi.waitFor(() => expect(events).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)))
  expect(endings).toEqual([])
  socket.cork(); f.pushes.get('sse')!({ sequence: 21, event: { content: 'x'.repeat(128_000) } })
  await tick(); expect(response.writableLength).toBeGreaterThan(65_536)
  await reader.dispose(); await vi.waitFor(() => expect(f.disposed.get('sse')).toBe(1))
  await vi.waitFor(() => expect(response.listenerCount('drain')).toBe(0))
  expect(events).toHaveLength(20)
})
