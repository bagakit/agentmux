import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from '../src/control.js'
import { parseMetricsObservation, type AgentMuxMetricsPort, type MetricsObservation } from '../src/metrics.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from '../src/public-rpc-frame.js'

const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'metrics-proof' } as const
const pending = { state: 'pending', data: null, observedAt: null, lastSuccessAt: null, reason: null } as const
function observation(): MetricsObservation {
  return { schema: 'agentmux.metrics.v1', observedAt: 1000,
    scope: { kind: 'unix-host', hostId: 'local', hostname: 'private-host', mainPid: 100 }, window: null,
    units: { cpu: 'percent', rss: 'KiB', storage: 'bytes', cpuAggregate: '10s-reading-peak', rssAggregate: 'latest' },
    process: { state: 'available', observedAt: 900, lastSuccessAt: 900, reason: null,
      data: [{ runId: 'healthy-run', hostId: 'local', rootPid: 100, processCount: 1, cpuPercent: 2,
        rssKib: 42, rootRssKib: 42, descendantsRssKib: 0, descendantProcessCount: 0 }] },
    app: pending, runtime: pending, main: pending, renderer: pending }
}
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function server(metrics?: AgentMuxMetricsPort) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-core-'))
  const path = join(directory, 'control.sock')
  const owner = new AgentMuxControlServer({ coreClients: () => [], execute: vi.fn(), ...(metrics ? { metrics } : {}) }, path)
  await owner.start()
  cleanups.push(async () => { await owner.stop(); await rm(directory, { recursive: true, force: true }) })
  return { owner, path }
}
async function raw(path: string, operation: 'metrics.get' | 'metrics.watch') {
  const socket = createConnection({ path, allowHalfOpen: true })
  cleanups.push(() => { socket.destroy() })
  await new Promise<void>(resolve => socket.once('connect', resolve))
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: base.requestId, method: operation === 'metrics.get' ? 'system.metrics.get' : 'system.metrics.watch', params: {} })}\n`)
  return socket
}
async function metricsGet(path: string) {
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  try { return await client.call('system.metrics.get', {}) } finally { await client.dispose() }
}
async function metricsWatch(path: string, options: { onFrame(value: any): void; onEnd(error?: Error): void; signal?: AbortSignal }) {
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  cleanups.push(() => client.dispose())
  return await client.subscribe('system.metrics.watch', {}, { ...options, onInitial: () => {}, onEvent: () => {} })
}
function opening(id: string) { return { jsonrpc: '2.0', id, result: { subscriptionId: 'reader', method: 'system.metrics.watch', initial: { observation: observation() } } } }
function snapshotFrame(sequence: number) { return { jsonrpc: '2.0', method: 'system.subscription.event', params: { subscriptionId: 'reader', method: 'system.metrics.watch', sequence, event: { type: 'snapshot', data: observation() } } } }
function firstFrame(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    socket.on('data', chunk => { buffer += chunk.toString(); if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0]!)) })
    socket.once('error', reject)
  })
}
const flush = () => new Promise(resolve => setImmediate(resolve))

describe('public metrics Control owner', () => {
  it('keeps unsupported typed and validates complete schema, parameters and source ages', async () => {
    const { path } = await server()
    await expect(metricsGet(path)).rejects.toMatchObject({ code: 'METRICS_UNSUPPORTED' })
    expect(parseMetricsObservation(observation()).process.data).toHaveLength(1)
    expect(agentMuxControlTimeoutMs('metrics.get')).toBe(agentMuxControlTimeoutMs('metrics.watch'))
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'metrics.get', host: 'guessed' })).toThrow()
    const malformed = observation(); malformed.process.data![0]!.cpuPercent = Number.NaN
    expect(() => parseMetricsObservation(malformed)).toThrow()
    const incomplete = observation() as unknown as Record<string, unknown>; delete incomplete.renderer
    expect(() => parseMetricsObservation(incomplete)).toThrow()
    const falsePending = observation(); falsePending.app = { ...pending, observedAt: 1000, lastSuccessAt: 1000 }
    expect(() => parseMetricsObservation(falsePending)).toThrow()
    const reordered = observation()
    reordered.window = { windowId: 1, webContentsId: 2, generation: 3 }
    reordered.renderer = { state: 'available', observedAt: 950, lastSuccessAt: 950, reason: null,
      data: { window: { generation: 3, windowId: 1, webContentsId: 2 }, counts: { monacoEditors: null, monacoModels: 0,
        documents: 1, runtimeSubscriptions: 1, terminalViews: 1, terminalAddons: 0, terminalListeners: 0 } } }
    expect(parseMetricsObservation(reordered).renderer.data!.counts.documents).toBe(1)
  })
  it('get finally releases on complete output while the actual peer is still half-open', async () => {
    let serverSocket!: Socket
    const phases: boolean[] = []
    const dispose = vi.fn(() => phases.push(serverSocket.destroyed))
    const { owner, path } = await server({ async subscribe(push) { push(observation()); return { dispose } } })
    ;(owner as unknown as { server: Server }).server.once('connection', socket => { serverSocket = socket })
    const socket = await raw(path, 'metrics.get')
    const frame = await firstFrame(socket)
    expect(frame).toMatchObject({ jsonrpc: '2.0', id: base.requestId, result: { observation: { process: { data: [{ runId: 'healthy-run' }] } } } })
    expect(dispose).toHaveBeenCalledOnce()
    expect(phases).toEqual([false])
    expect(socket.destroyed).toBe(false)
  })
  it('coalesces synchronous snapshots to one latest frame after real opening backpressure', async () => {
    let serverSocket!: Socket
    const dispose = vi.fn()
    const { owner, path } = await server({ async subscribe(push) {
      for (let i = 0; i < 50; i++) push({ ...observation(), observedAt: 1000 + i })
      return { dispose }
    } })
    ;(owner as unknown as { server: Server }).server.once('connection', socket => {
      serverSocket = socket
      ;(socket as any)._writableState.highWaterMark = 1
    })
    const frames: any[] = [], ended = vi.fn()
    const subscription = await metricsWatch(path, { onFrame: value => frames.push(value), onEnd: ended })
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(frames.map(frame => 'result' in frame ? 'response' : frame.params.event.type)).toEqual(['response','snapshot'])
    expect(frames[0].result.initial.observation.observedAt).toBe(1000)
    expect(frames[1].params.event.data.observedAt).toBe(1049)
    expect(serverSocket.writableHighWaterMark).toBe(1)
    await subscription.dispose()
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })
  it('get owner close before first snapshot returns a typed get error and releases', async () => {
    const dispose = vi.fn()
    const { path } = await server({ async subscribe(_push, end) { queueMicrotask(() => end()); return { dispose } } })
    await expect(metricsGet(path)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(dispose).toHaveBeenCalledOnce()
  })
  it.each(['FIN', 'close', 'stop', 'deadline'] as const)('disposes delayed establishment after %s without late frames', async kind => {
    let settle!: (value: { dispose(): void }) => void
    let established!: () => void
    const entered = new Promise<void>(resolve => { established = resolve })
    const dispose = vi.fn()
    const { owner, path } = await server({ subscribe() { established(); return new Promise(resolve => { settle = resolve }) } })
    const socket = await raw(path, 'metrics.watch')
    const frames: string[] = []
    socket.on('data', chunk => frames.push(chunk.toString()))
    const response = kind === 'deadline' ? firstFrame(socket) : undefined
    await entered
    if (kind === 'FIN') socket.end()
    else if (kind === 'close') socket.destroy()
    else if (kind === 'stop') await owner.stop()
    else {
      const frame = await response!
      expect(frame).toMatchObject({ jsonrpc: '2.0', id: base.requestId, error: { data: { code: 'CONTROL_TIMEOUT' } } })
    }
    await flush(); await flush()
    settle({ dispose }); await flush(); await flush()
    expect(dispose).toHaveBeenCalledOnce()
    expect(frames.join('')).not.toContain('"type":"snapshot"')
    expect(frames.join('')).not.toContain('"subscriptionId"')
    await owner.stop()
  })
  it.each(['disconnect', 'deadline'] as const)('releases get waiting for its first sample after %s', async kind => {
    const dispose = vi.fn()
    const { path } = await server({ async subscribe() { return { dispose } } })
    const socket = await raw(path, 'metrics.get')
    if (kind === 'disconnect') { await flush(); socket.destroy(); await flush(); await flush() }
    else expect(await firstFrame(socket)).toMatchObject({ jsonrpc: '2.0', id: base.requestId, error: { data: { code: 'CONTROL_TIMEOUT' } } })
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })
  it('rejects a real JSON-RPC opening whose response identity does not match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-corrupt-')), path = join(directory, 'control.sock')
    const owner = createServer(socket => socket.once('data', () => socket.end(JSON.stringify({
      ...opening('other-request')
    }) + '\n')))
    await new Promise<void>(resolve => owner.listen(path, resolve))
    cleanups.push(async () => { await new Promise<void>(resolve => owner.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
    const result = await metricsWatch(path, { onFrame: vi.fn(), onEnd: vi.fn() })
      .then(subscription => { subscription.dispose(); return { opened: true, error: null } },
        error => ({ opened: false, error: error.code }))
    expect(result).toEqual({ opened: false, error: 'CONTROL_PROTOCOL_ERROR' })
  })
  it('ended consumer receives no same-chunk snapshots after cancelling in the actual attached callback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-cancel-')), path = join(directory, 'control.sock')
    const sockets = new Set<Socket>(), controller = new AbortController()
    const owner = createServer(socket => {
      sockets.add(socket)
      socket.once('data', chunk => { const request = JSON.parse(chunk.toString()); socket.write([
        opening(request.id), snapshotFrame(1), snapshotFrame(2)
      ].map(frame => JSON.stringify(frame) + '\n').join('')) })
    })
    await new Promise<void>(resolve => owner.listen(path, resolve))
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => owner.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
    const events: string[] = [], ends: string[] = []
    const subscription = await metricsWatch(path, {
      onFrame: frame => { events.push('result' in frame ? 'response' : frame.params.event.type); if ('result' in frame) controller.abort() },
      onEnd: error => ends.push((error as { code?: string } | undefined)?.code ?? 'end'), signal: controller.signal
    })
    expect(subscription.subscriptionId).toBe('reader')
    await flush()
    expect(ends).toEqual(['CONTROL_CANCELLED'])
    expect(events).toEqual(['response'])
  })
  it('ends before any business callback when the actual notification-frame consumer cancels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-event-cancel-')), path = join(directory, 'control.sock')
    const sockets = new Set<Socket>(), controller = new AbortController()
    const owner = createServer(socket => {
      sockets.add(socket)
      socket.once('data', chunk => { const request = JSON.parse(chunk.toString()); socket.write([
        opening(request.id), snapshotFrame(1), snapshotFrame(2)
      ].map(frame => JSON.stringify(frame) + '\n').join('')) })
    })
    await new Promise<void>(resolve => owner.listen(path, resolve))
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => owner.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
    cleanups.push(() => client.dispose())
    const events: string[] = []
    await client.subscribe('system.metrics.watch', {}, {
      signal: controller.signal,
      onFrame: frame => { events.push('result' in frame ? 'response' : 'snapshot'); if (!('result' in frame)) controller.abort() },
      onInitial: () => { events.push('initial') },
      onEvent: () => { events.push('event') },
      onEnd: error => { events.push((error as { code?: string } | undefined)?.code ?? 'end') }
    })
    await flush()
    expect(events).toEqual(['response', 'initial', 'snapshot', 'CONTROL_CANCELLED'])
  })
  it.each(['abort', 'dispose', 'stop'] as const)('releases a delayed public SDK watcher after %s without delivering a late sample', async kind => {
    let settle!: (value: { dispose(): void }) => void, enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), dispose = vi.fn()
    const { owner, path } = await server({ subscribe() { enter(); return new Promise(resolve => { settle = resolve }) } })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
    cleanups.push(() => client.dispose())
    const controller = new AbortController(), initial = vi.fn(), events = vi.fn()
    const opening = client.subscribe('system.metrics.watch', {}, { signal: controller.signal, onInitial: initial, onEvent: events })
      .then(() => ({ opened: true, code: null }), error => ({ opened: false, code: error.code }))
    await entered
    if (kind === 'abort') controller.abort(); else if (kind === 'dispose') await client.dispose(); else await owner.stop()
    const outcome = await opening
    expect(outcome.opened).toBe(false)
    expect(outcome.code).toBe(kind === 'stop' ? 'CONTROL_PROTOCOL_ERROR' : 'CONTROL_CANCELLED')
    settle({ dispose }); await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    expect(initial).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled()
  })
  it('cancellation inside the initial callback suppresses all same-chunk samples after a committed opening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-initial-cancel-')), path = join(directory, 'control.sock')
    const sockets = new Set<Socket>(), controller = new AbortController()
    const owner = createServer(socket => {
      sockets.add(socket)
      socket.once('data', chunk => { const request = JSON.parse(chunk.toString()); socket.write([
        opening(request.id), snapshotFrame(1), snapshotFrame(2)
      ].map(frame => JSON.stringify(frame) + '\n').join('')) })
    })
    await new Promise<void>(resolve => owner.listen(path, resolve))
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => owner.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanups.push(() => client.dispose())
    const initial = vi.fn(() => controller.abort()), events = vi.fn(), ends = vi.fn()
    const subscription = await client.subscribe('system.metrics.watch', {}, { signal: controller.signal, onInitial: initial, onEvent: events, onEnd: ends })
    expect(subscription.subscriptionId).toBe('reader')
    await flush(); expect(initial).toHaveBeenCalledOnce(); expect(events).not.toHaveBeenCalled()
    expect(ends).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'CONTROL_CANCELLED' }))
  })
  it('bounds a complete oversized source without truncating into success', async () => {
    const tooLarge = observation()
    tooLarge.process.data = Array.from({ length: 4096 }, (_, i) => ({ ...observation().process.data![0]!,
      runId: `run-${i}-${'界'.repeat(4000)}`, hostId: `host-${'界'.repeat(2000)}` }))
    expect(parseMetricsObservation(tooLarge)).toBe(tooLarge)
    expect(Buffer.byteLength(JSON.stringify(tooLarge))).toBeGreaterThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    const dispose = vi.fn()
    const { path } = await server({ async subscribe(push) { push(tooLarge); return { dispose } } })
    await expect(metricsGet(path)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(dispose).toHaveBeenCalledOnce()
  })
  it.each(['json-without-LF','partial-json'])('rejects EOF after opening with an incomplete %s frame', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-eof-')), path = join(directory, 'control.sock')
    const owner = createServer(socket => socket.once('data', chunk => {
      const request = JSON.parse(chunk.toString())
      const next = JSON.stringify(snapshotFrame(1))
      socket.end(JSON.stringify(opening(request.id)) + '\n' + (kind === 'partial-json' ? next.slice(0, 50) : next))
    }))
    await new Promise<void>(resolve => owner.listen(path, resolve))
    cleanups.push(async () => { await new Promise<void>(resolve => owner.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
    const frames: unknown[] = [], ended = vi.fn()
    await metricsWatch(path, { onFrame: value => frames.push(value), onEnd: ended })
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce())
    expect(frames).toHaveLength(1)
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
})
