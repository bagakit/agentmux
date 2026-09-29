import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, requestAgentMuxControl, subscribeAgentMuxMetrics, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from '../src/control.js'
import { parseMetricsObservation, type AgentMuxMetricsPort, type MetricsObservation } from '../src/metrics.js'

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
  const owner = new AgentMuxControlServer({ execute: vi.fn(), ...(metrics ? { metrics } : {}) }, path)
  await owner.start()
  cleanups.push(async () => { await owner.stop(); await rm(directory, { recursive: true, force: true }) })
  return { owner, path }
}
async function raw(path: string, operation: 'metrics.get' | 'metrics.watch') {
  const socket = createConnection({ path, allowHalfOpen: true })
  cleanups.push(() => { socket.destroy() })
  await new Promise<void>(resolve => socket.once('connect', resolve))
  socket.write(`${JSON.stringify({ ...base, operation })}\n`)
  return socket
}
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
    await expect(requestAgentMuxControl({ ...base, operation: 'metrics.get' }, path)).rejects.toMatchObject({ code: 'METRICS_UNSUPPORTED' })
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
    expect(frame).toMatchObject({ ok: true, operation: 'metrics.get', result: { observation: { process: { data: [{ runId: 'healthy-run' }] } } } })
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
    const subscription = await subscribeAgentMuxMetrics({ ...base, operation: 'metrics.watch' }, {
      onFrame: value => frames.push(value), onEnd: ended }, { path })
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(frames.map(frame => frame.event)).toEqual(['attached','snapshot'])
    expect(frames[1].result.observation.observedAt).toBe(1049)
    expect(serverSocket.writableHighWaterMark).toBe(1)
    subscription.dispose()
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })
  it('get owner close before first snapshot returns a typed get error and releases', async () => {
    const dispose = vi.fn()
    const { path } = await server({ async subscribe(_push, end) { queueMicrotask(() => end()); return { dispose } } })
    await expect(requestAgentMuxControl({ ...base, operation: 'metrics.get' }, path)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
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
    await entered
    if (kind === 'FIN') socket.end()
    else if (kind === 'close') socket.destroy()
    else if (kind === 'stop') await owner.stop()
    else {
      const frame = await firstFrame(socket)
      expect(frame).toMatchObject({ ok: false, operation: 'metrics.watch', error: { code: 'CONTROL_TIMEOUT' } })
    }
    await flush(); await flush()
    settle({ dispose }); await flush(); await flush()
    expect(dispose).toHaveBeenCalledOnce()
    expect(frames.join('')).not.toContain('"event":"snapshot"')
    expect(frames.join('')).not.toContain('"event":"attached"')
    await owner.stop()
  })
  it.each(['disconnect', 'deadline'] as const)('releases get waiting for its first sample after %s', async kind => {
    const dispose = vi.fn()
    const { path } = await server({ async subscribe() { return { dispose } } })
    const socket = await raw(path, 'metrics.get')
    if (kind === 'disconnect') { await flush(); socket.destroy(); await flush(); await flush() }
    else expect(await firstFrame(socket)).toMatchObject({ ok: false, operation: 'metrics.get', error: { code: 'CONTROL_TIMEOUT' } })
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })
  it('rejects a real NDJSON opening whose request identity does not match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-corrupt-')), path = join(directory, 'control.sock')
    const owner = createServer(socket => socket.once('data', () => socket.end(JSON.stringify({
      ...base, requestId: 'other-request', operation: 'metrics.watch', ok: true, event: 'attached', result: {}
    }) + '\n')))
    await new Promise<void>(resolve => owner.listen(path, resolve))
    cleanups.push(async () => { await new Promise<void>(resolve => owner.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
    const result = await subscribeAgentMuxMetrics({ ...base, operation: 'metrics.watch' }, { onFrame: vi.fn(), onEnd: vi.fn() }, { path })
      .then(subscription => { subscription.dispose(); return { opened: true, error: null } },
        error => ({ opened: false, error: error.code }))
    expect(result).toEqual({ opened: false, error: 'CONTROL_PROTOCOL_ERROR' })
  })
  it('ended consumer receives no same-chunk snapshots after cancelling in the actual attached callback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-cancel-')), path = join(directory, 'control.sock')
    const sockets = new Set<Socket>(), controller = new AbortController()
    const owner = createServer(socket => {
      sockets.add(socket)
      socket.once('data', () => socket.write([
        { ...base, operation: 'metrics.watch', ok: true, event: 'attached', result: {} },
        ...[0, 1].map(() => ({ ...base, operation: 'metrics.watch', ok: true, event: 'snapshot', result: { observation: observation() } }))
      ].map(frame => JSON.stringify(frame) + '\n').join('')))
    })
    await new Promise<void>(resolve => owner.listen(path, resolve))
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => owner.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
    const events: string[] = [], ends: string[] = []
    const subscription = await subscribeAgentMuxMetrics({ ...base, operation: 'metrics.watch' }, {
      onFrame: frame => { events.push(frame.event); if (frame.event === 'attached') controller.abort() },
      onEnd: error => ends.push((error as { code?: string } | undefined)?.code ?? 'end')
    }, { path, signal: controller.signal })
    await flush()
    subscription.dispose()
    expect(ends).toEqual(['CONTROL_CANCELLED'])
    expect(events).toEqual(['attached'])
  })
  it('bounds a complete oversized source without truncating into success', async () => {
    const tooLarge = observation()
    tooLarge.process.data = Array.from({ length: 4096 }, (_, i) => ({ ...observation().process.data![0]!, runId: `run-${i}-${'x'.repeat(3000)}` }))
    const dispose = vi.fn()
    const { path } = await server({ async subscribe(push) { push(tooLarge); return { dispose } } })
    await expect(requestAgentMuxControl({ ...base, operation: 'metrics.get' }, path)).rejects.toMatchObject({ code: 'CONTROL_FAILED' })
    expect(dispose).toHaveBeenCalledOnce()
  })
  it.each(['json-without-LF','partial-json'])('rejects EOF after opening with an incomplete %s frame', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-metrics-eof-')), path = join(directory, 'control.sock')
    const owner = createServer(socket => socket.once('data', () => {
      const opening = { ...base, operation: 'metrics.watch', ok: true, event: 'attached', result: {} }
      const next = JSON.stringify({ ...base, operation: 'metrics.watch', ok: true, event: 'snapshot', result: { observation: observation() } })
      socket.end(JSON.stringify(opening) + '\n' + (kind === 'partial-json' ? next.slice(0, 50) : next))
    }))
    await new Promise<void>(resolve => owner.listen(path, resolve))
    cleanups.push(async () => { await new Promise<void>(resolve => owner.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
    const frames: unknown[] = [], ended = vi.fn()
    await subscribeAgentMuxMetrics({ ...base, operation: 'metrics.watch' }, { onFrame: value => frames.push(value), onEnd: ended }, { path })
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce())
    expect(frames).toHaveLength(1)
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
})
