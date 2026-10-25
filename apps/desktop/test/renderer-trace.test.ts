import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { RendererTimelineTracer } from '../src/main/renderer-trace'
import { createResourceMetricsPort } from '../src/main/resource-usage-control'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host'
import { agentMuxControlTimeoutMs } from '../../../packages/core/src/control'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
import { rpcControlRequest, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { RENDERER_TRACE_CATEGORIES, RENDERER_TRACE_MAX_BYTES, parseRendererTraceInput,
  parseRendererTraceResult, type RendererTraceResult } from '../../../packages/core/src/renderer-trace'
import { writeRendererTrace } from '../../../packages/core/src/renderer-trace-cli'
import { writeRendererV8Profile } from '../../../packages/core/src/renderer-v8-profile-cli'
import { compileRendererProfileCli } from '../../../packages/core/test/helpers/renderer-profile-cli'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const target = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }
const input = (durationMs = 1000) => ({ target: { ...target }, durationMs })
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const originalEvents = () => [{ pid: 4, tid: 8, ph: 'X', ts: 1.5, dur: 2, name: 'Layout', cat: 'devtools.timeline',
  args: { original: { text: 'λ', list: [null, true, 3], futureField: { retained: 'exact' } } } },
  { pid: 4, tid: 8, ph: 'i', ts: 4, name: 'private-timeline-marker', cat: 'blink.user_timing', args: {} }]
// Preserve native JSON whitespace, original event order and unrelated top-level metadata.
const nativeJSON = () => Buffer.from('{\n  "traceEvents": ' + JSON.stringify(originalEvents()) + ',\n  "metadata": {"original":"λ"}\n}\n')
const disposers: Array<() => void | Promise<void>> = []
function fixture() {
  let current: typeof target | null = { ...target }, offset = 0
  const state = { attached: false, devtools: false, destroyed: false, nativeForeignTrace: false,
    start: (): Promise<unknown> => Promise.resolve({}), end: (): Promise<unknown> => Promise.resolve({}),
    close: (): Promise<unknown> => Promise.resolve({}), read: null as (() => Promise<unknown>) | null,
    completeOnEnd: true, dataLoss: false, raw: nativeJSON(), gzip: null as Buffer | null,
    handle: 'original-native-stream', chunkBytes: 64 * 1024, emptyBeforeData: false,
    activeReads: 0, maxActiveReads: 0, onEnd: () => {} }
  function complete(overrides: Record<string, unknown> = {}, sessionId = '') {
    debuggerClient.emit('message', {}, 'Tracing.tracingComplete', { stream: state.handle,
      traceFormat: 'json', streamCompression: 'gzip', dataLossOccurred: state.dataLoss, ...overrides }, sessionId)
  }
  const debuggerClient = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => state.attached),
    attach: vi.fn(() => { if (state.attached) throw new Error('Already attached'); state.attached = true }),
    detach: vi.fn(() => { state.attached = false; debuggerClient.emit('detach') }),
    sendCommand: vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
      if (method === 'Tracing.start') {
        if (state.nativeForeignTrace) throw new Error('Tracing has already been started in another tab.')
        offset = 0
        return state.start()
      }
      if (method === 'Tracing.end') {
        state.onEnd()
        if (state.completeOnEnd) complete()
        return state.end()
      }
      if (method === 'IO.read') {
        state.activeReads++; state.maxActiveReads = Math.max(state.maxActiveReads, state.activeReads)
        try {
          expect(params).toEqual({ handle: state.handle, size: 64 * 1024 })
          if (state.read) return await state.read()
          if (state.emptyBeforeData) { state.emptyBeforeData = false; return { data: '', eof: false, base64Encoded: true } }
          const compressed = state.gzip ?? gzipSync(state.raw), chunk = compressed.subarray(offset, offset + state.chunkBytes)
          offset += chunk.length
          return { data: chunk.toString('base64'), base64Encoded: true, eof: offset === compressed.length }
        } finally { state.activeReads-- }
      }
      if (method === 'IO.close') { expect(params).toEqual({ handle: state.handle }); return state.close() }
      return {}
    })
  })
  const contents = Object.assign(new EventEmitter(), { debugger: debuggerClient, isDestroyed: () => state.destroyed,
    isDevToolsOpened: () => state.devtools })
  const tracer = new RendererTimelineTracer(contents as unknown as WebContents, () => current)
  disposers.push(() => tracer.dispose())
  return { tracer, state, contents, debuggerClient, complete,
    setCurrent(value: typeof target | null) { current = value } }
}
async function finish(f: ReturnType<typeof fixture>, duration = 1000) {
  const pending = f.tracer.capture(input(duration)); await vi.advanceTimersByTimeAsync(duration); return pending
}
const methods = (f: ReturnType<typeof fixture>) => f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); vi.useRealTimers(); vi.restoreAllMocks() })

it.each([1000, 5000])('preserves original gzip and raw JSON for %i ms through serial reads, terminal data/EOF and close ACK', async duration => {
  vi.useFakeTimers(); const f = fixture(); f.state.chunkBytes = 19; f.state.emptyBeforeData = true
  const result = await finish(f, duration), compressed = gzipSync(f.state.raw)
  expect(result.status).toBe('completed'); expect(result.schema).toBe('agentmux.renderer-trace.v2')
  expect(result.trace).toEqual({ encoding: 'base64', data: compressed.toString('base64'), bytes: compressed.length, sha256: sha(compressed) })
  expect(Buffer.compare(gunzipSync(Buffer.from(result.trace!.data, 'base64')), f.state.raw)).toBe(0)
  expect(result.receivedEvents).toBe(originalEvents().length)
  expect(result.receivedTraceBytes).toBe(f.state.raw.length); expect(result.receivedGzipBytes).toBe(compressed.length)
  expect(result.traceBytes).toBe(f.state.raw.length); expect(result.sha256).toBe(sha(f.state.raw))
  expect(result.stream).toEqual({ handleReceived: true, eof: true, closeRequested: true, closeAcknowledged: true })
  expect(result.lifecycle).toEqual({ startRequested: true, startAcknowledged: true, endRequested: true,
    endAcknowledged: true, tracingComplete: true, dataLossOccurred: false, detached: 'confirmed' })
  expect(result.sourceVerified).toEqual({ before: true, after: true })
  expect(result.timing.endMonotonicMs! - result.timing.startMonotonicMs!).toBeGreaterThanOrEqual(duration)
  expect(methods(f).slice(0, 2)).toEqual(['Tracing.start', 'Tracing.end'])
  expect(methods(f).filter(method => method === 'IO.read').length).toBeGreaterThan(2)
  expect(methods(f).at(-1)).toBe('IO.close'); expect(f.state.maxActiveReads).toBe(1)
  expect(f.debuggerClient.sendCommand.mock.calls[0]![1]).toEqual({ transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'gzip', bufferUsageReportingInterval: 250,
    traceConfig: { recordMode: 'recordUntilFull', includedCategories: [...RENDERER_TRACE_CATEGORIES],
      excludedCategories: ['disabled-by-default-devtools.screenshot', 'disabled-by-default-memory-infra', 'disabled-by-default-v8.cpu_profiler'] } })
  expect(f.debuggerClient.listenerCount('message')).toBe(0); expect(f.state.attached).toBe(false)
})
it.each(['attached', 'devtools'] as const)('refuses a pre-existing %s owner without attaching or changing it', async kind => {
  const f = fixture(); f.state[kind] = true
  await expect(f.tracer.capture(input())).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.debuggerClient.attach).not.toHaveBeenCalled(); expect(f.debuggerClient.detach).not.toHaveBeenCalled()
  expect(f.state[kind]).toBe(true)
})
it('requests native triggering stacks while retained category facts remain independent of the current producer', async () => {
  vi.useFakeTimers()
  const f = fixture(), result = await finish(f)
  expect(result.requestedCategories).toContain('disabled-by-default-devtools.timeline.stack')
  expect(result.requestedCategories).not.toContain('disabled-by-default-devtools.timeline.invalidationTracking')
  const retained = { ...result, requestedCategories: ['devtools.timeline', 'original-producer-category'] }
  expect(parseRendererTraceResult(retained).requestedCategories).toEqual(retained.requestedCategories)
  expect(parseRendererTraceResult(retained).trace).toEqual(result.trace)
  for (const categories of [[], [''], [1], ['valid', null]])
    expect(() => parseRendererTraceResult({ ...result, requestedCategories: categories })).toThrow()
  expect(() => parseRendererTraceResult({ ...result, requestedCategories: ['x'.repeat(64 * 1024)] })).toThrow()
})
it('does not end a foreign native trace after its own start was rejected', async () => {
  const f = fixture(); f.state.nativeForeignTrace = true
  const result = await f.tracer.capture(input())
  expect(result.status).toBe('failed'); expect(result.lifecycle.startAcknowledged).toBe(false)
  expect(result.lifecycle.endRequested).toBe(false); expect(result.lifecycle.tracingComplete).toBe(false)
  expect(methods(f)).toEqual(['Tracing.start']); expect(f.state.nativeForeignTrace).toBe(true)
  expect(result.lifecycle.detached).toBe('confirmed')
})
it('requires the original complete handle after end ACK; foreign completion cannot supply it', async () => {
  vi.useFakeTimers(); const f = fixture(); f.state.completeOnEnd = false
  let settled = false
  const pending = f.tracer.capture(input()); void pending.then(() => { settled = true }, () => { settled = true })
  await vi.advanceTimersByTimeAsync(1000)
  expect(methods(f)).toEqual(['Tracing.start', 'Tracing.end']); expect(settled).toBe(false)
  f.complete({ stream: 'foreign-stream' }, 'foreign-session'); await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false); expect(methods(f)).not.toContain('IO.read')
  f.complete(); const result = await pending
  expect(result.lifecycle.endAcknowledged).toBe(true); expect(result.lifecycle.tracingComplete).toBe(true)
  expect(result.stream.closeAcknowledged).toBe(true)
})
it('closes only the first original handle when completion metadata is invalid and a later completion tries to replace it', async () => {
  vi.useFakeTimers(); const f = fixture(); f.state.completeOnEnd = false
  f.state.onEnd = () => { f.complete({ dataLossOccurred: null }); f.complete({ stream: 'later-foreign-stream' }) }
  const result = await finish(f)
  expect(result.status).toBe('failed'); expect(result.trace).toBeNull()
  expect(result.lifecycle.tracingComplete).toBe(false); expect(result.lifecycle.dataLossOccurred).toBeNull()
  expect(result.stream).toEqual({ handleReceived: true, eof: false, closeRequested: true, closeAcknowledged: true })
  expect(f.debuggerClient.sendCommand.mock.calls.filter(([method]) => method === 'IO.close')).toEqual([
    ['IO.close', { handle: 'original-native-stream' }]
  ])
  expect(methods(f)).not.toContain('IO.read'); expect(result.lifecycle.detached).toBe('confirmed')
})
it('keeps pending start cancellation unknown, never ends it, and ignores its late ACK', async () => {
  vi.useFakeTimers(); const f = fixture(), signal = new AbortController()
  let resolveStart!: (value: object) => void
  f.state.start = () => new Promise(resolve => { resolveStart = resolve })
  const pending = f.tracer.capture(input(), signal.signal)
  await vi.advanceTimersByTimeAsync(0); signal.abort(); await vi.advanceTimersByTimeAsync(0)
  const result = await pending, saved = structuredClone(result)
  expect(result.status).toBe('unknown'); expect(result.lifecycle.startAcknowledged).toBe(false)
  expect(result.lifecycle.endRequested).toBe(false); expect(result.stream.handleReceived).toBe(false)
  expect(result.lifecycle.detached).toBe('confirmed')
  resolveStart({}); f.complete(); await vi.advanceTimersByTimeAsync(0)
  expect(result).toEqual(saved); expect(methods(f)).toEqual(['Tracing.start'])
})
it('bounds cancelled pending end cleanup without inventing end, flush or stream ACK', async () => {
  vi.useFakeTimers(); const f = fixture(), signal = new AbortController()
  let resolveEnd!: (value: object) => void
  f.state.completeOnEnd = false; f.state.end = () => new Promise(resolve => { resolveEnd = resolve })
  const pending = f.tracer.capture(input(), signal.signal); await vi.advanceTimersByTimeAsync(0); signal.abort()
  // Main owns a separate bounded cleanup observation; cancellation is not its ACK.
  await vi.advanceTimersByTimeAsync(1100)
  const result = await pending, saved = structuredClone(result)
  expect(result.status).toBe('unknown'); expect(result.lifecycle.endRequested).toBe(true)
  expect(result.lifecycle.endAcknowledged).toBe(false); expect(result.lifecycle.tracingComplete).toBe(false)
  expect(result.stream).toEqual({ handleReceived: false, eof: false, closeRequested: false, closeAcknowledged: false })
  expect(methods(f)).toEqual(['Tracing.start', 'Tracing.end']); expect(result.lifecycle.detached).toBe('confirmed')
  resolveEnd({}); f.complete(); await vi.advanceTimersByTimeAsync(0); expect(result).toEqual(saved)
})
it('cancels a pending read, closes its known handle once and ignores the late bytes', async () => {
  vi.useFakeTimers(); const f = fixture(), signal = new AbortController()
  let reply!: (value: unknown) => void
  f.state.read = () => new Promise(resolve => { reply = resolve })
  const pending = f.tracer.capture(input(), signal.signal); await vi.advanceTimersByTimeAsync(1000)
  expect(methods(f)).toEqual(['Tracing.start', 'Tracing.end', 'IO.read'])
  signal.abort(); await vi.advanceTimersByTimeAsync(600)
  const result = await pending, saved = structuredClone(result)
  expect(result.status).toBe('unknown'); expect(result.trace).toBeNull()
  expect(result.stream).toEqual({ handleReceived: true, eof: false, closeRequested: true, closeAcknowledged: true })
  expect(methods(f).filter(method => method === 'IO.close')).toHaveLength(1)
  reply({ data: gzipSync(f.state.raw).toString('base64'), base64Encoded: true, eof: true })
  await vi.advanceTimersByTimeAsync(0); expect(result).toEqual(saved)
  f.state.read = null; f.state.handle = 'next-owned-stream'
  const next = await finish(f)
  expect(next.status).toBe('completed'); expect(next.sha256).toBe(sha(f.state.raw)); expect(result).toEqual(saved)
  expect(f.debuggerClient.sendCommand.mock.calls.filter(([method]) => method === 'IO.close').map(([, params]) => params)).toEqual([
    { handle: 'original-native-stream' }, { handle: 'next-owned-stream' }
  ])
})
it('does not detach or end a new foreign debugger after owner loss', async () => {
  vi.useFakeTimers(); const f = fixture(), pending = f.tracer.capture(input())
  await vi.advanceTimersByTimeAsync(0); f.state.attached = false; f.debuggerClient.emit('detach'); f.state.attached = true
  const result = await pending
  expect(result.status).toBe('unknown'); expect(result.lifecycle.detached).toBe('owner-lost')
  expect(f.debuggerClient.detach).not.toHaveBeenCalled(); expect(f.state.attached).toBe(true)
  expect(methods(f)).toEqual(['Tracing.start'])
})
it('never closes a handle or consumes late bytes after a foreign owner replaces a pending read', async () => {
  vi.useFakeTimers(); const f = fixture(); let reply!: (value: unknown) => void
  f.state.read = () => new Promise(resolve => { reply = resolve })
  const pending = f.tracer.capture(input()); await vi.advanceTimersByTimeAsync(1000)
  expect(methods(f)).toContain('IO.read')
  f.state.attached = false; f.debuggerClient.emit('detach'); f.state.attached = true; f.state.nativeForeignTrace = true
  await vi.advanceTimersByTimeAsync(600)
  const result = await pending, saved = structuredClone(result)
  expect(result.status).toBe('unknown'); expect(result.lifecycle.detached).toBe('owner-lost')
  expect(methods(f)).not.toContain('IO.close'); expect(f.debuggerClient.detach).not.toHaveBeenCalled()
  reply({ data: gzipSync(f.state.raw).toString('base64'), base64Encoded: true, eof: true }); f.complete({ stream: 'foreign-stream' })
  await vi.advanceTimersByTimeAsync(0); expect(result).toEqual(saved); expect(f.state.nativeForeignTrace).toBe(true)
})
it('rejects a changed source even if the original end and complete arrived', async () => {
  vi.useFakeTimers(); const f = fixture()
  f.state.onEnd = () => { f.setCurrent({ ...target, generation: target.generation + 1 }); f.contents.emit('did-start-navigation') }
  const result = await finish(f)
  expect(result.status).toBe('unknown'); expect(result.sourceVerified.after).toBe(false); expect(result.trace).toBeNull()
})
it('does not convert data loss or an observed full buffer into complete coverage', async () => {
  vi.useFakeTimers(); const f = fixture(); f.state.dataLoss = true
  const result = await finish(f)
  expect(result.status).toBe('failed'); expect(Buffer.compare(gunzipSync(Buffer.from(result.trace!.data, 'base64')), f.state.raw)).toBe(0)
  expect(result.issues[0]!.stage).toBe('data-loss')
  const g = fixture()
  g.state.close = async () => { g.debuggerClient.emit('message', {}, 'Tracing.bufferUsage', { percentFull: 1 }); return {} }
  const full = await finish(g)
  expect(full.status).toBe('failed'); expect(full.bufferUsage.fullObserved).toBe(true)
  expect(full.stream.closeAcknowledged).toBe(true); expect(full.lifecycle.detached).toBe('confirmed')
  expect(full.issues).toContainEqual(expect.objectContaining({ stage: 'data-loss' }))
})
it('rejects invalid gzip after explicit EOF, still closes the original handle and never publishes fake material', async () => {
  vi.useFakeTimers(); const f = fixture(); f.state.gzip = Buffer.from('not gzip')
  const result = await finish(f)
  expect(result.status).toBe('failed'); expect(result.trace).toBeNull(); expect(result.stream.eof).toBe(true)
  expect(result.stream.closeAcknowledged).toBe(true); expect(result.lifecycle.detached).toBe('confirmed')
  expect(result.issues.length).toBeGreaterThan(0); expect(methods(f).filter(method => method === 'IO.close')).toHaveLength(1)
})
it('rejects a native chunk larger than the requested 64 KiB without truncation', async () => {
  vi.useFakeTimers(); const f = fixture()
  f.state.read = async () => ({ data: Buffer.alloc(64 * 1024 + 1).toString('base64'), base64Encoded: true, eof: true })
  const result = await finish(f)
  expect(result.status).toBe('failed'); expect(result.receivedGzipBytes).toBe(64 * 1024 + 1)
  expect(result.trace).toBeNull(); expect(result.stream.eof).toBe(true); expect(result.stream.closeAcknowledged).toBe(true)
})
it('retains an IO.close failure as unconfirmed cleanup, not a completed trace or an automatic retry', async () => {
  vi.useFakeTimers(); const f = fixture(); f.state.close = async () => { throw new Error('native close ACK missing') }
  const result = await finish(f)
  expect(result.status).toBe('failed'); expect(result.trace).toBeNull()
  expect(result.stream).toEqual({ handleReceived: true, eof: true, closeRequested: true, closeAcknowledged: false })
  expect(result.issues).toContainEqual(expect.objectContaining({ stage: 'close', message: 'native close ACK missing' }))
  expect(methods(f).filter(method => method === 'IO.close')).toHaveLength(1)
})
it('keeps a normal close ACK beyond 500 ms within the original request budget', async () => {
  vi.useFakeTimers(); const f = fixture()
  let entered!: () => void, acknowledge!: () => void
  const closeEntered = new Promise<void>(resolve => { entered = resolve })
  const originalClose = new Promise<unknown>(resolve => { acknowledge = () => resolve({}) })
  f.state.close = () => { entered(); return originalClose }
  let settled = false
  const pending = f.tracer.capture(input()); void pending.then(() => { settled = true }, () => { settled = true })
  try {
    await vi.advanceTimersByTimeAsync(1000); await closeEntered
    await vi.advanceTimersByTimeAsync(750)
    expect(settled).toBe(false)
    expect(methods(f).filter(method => method === 'IO.close')).toHaveLength(1)
    acknowledge(); const result = await pending
    expect(result.status).toBe('completed'); expect(result.stream.closeAcknowledged).toBe(true)
    expect(result.lifecycle.detached).toBe('confirmed'); expect(result.sha256).toBe(sha(f.state.raw))
    expect(result.issues).toEqual([])
  } finally { acknowledge(); await vi.advanceTimersByTimeAsync(0); await pending.catch(() => {}) }
})
it('observes the same pending close ACK after cancellation without resending or claiming completed', async () => {
  vi.useFakeTimers(); const f = fixture(), signal = new AbortController()
  let entered!: () => void, acknowledge!: () => void
  const closeEntered = new Promise<void>(resolve => { entered = resolve })
  const originalClose = new Promise<unknown>(resolve => { acknowledge = () => resolve({}) })
  f.state.close = () => { entered(); return originalClose }
  let settled = false
  const pending = f.tracer.capture(input(), signal.signal); void pending.then(() => { settled = true }, () => { settled = true })
  try {
    await vi.advanceTimersByTimeAsync(1000); await closeEntered
    signal.abort(); await vi.advanceTimersByTimeAsync(250)
    expect(settled).toBe(false)
    expect(methods(f).filter(method => method === 'IO.close')).toHaveLength(1)
    acknowledge(); const result = await pending
    expect(result.status).toBe('unknown'); expect(result.trace).toBeNull()
    expect(result.stream).toEqual({ handleReceived: true, eof: true, closeRequested: true, closeAcknowledged: true })
    expect(result.lifecycle.detached).toBe('confirmed')
    expect(f.debuggerClient.sendCommand.mock.calls.filter(([method]) => method === 'IO.close')).toEqual([
      ['IO.close', { handle: 'original-native-stream' }]
    ])
  } finally { signal.abort(); acknowledge(); await vi.advanceTimersByTimeAsync(600); await pending.catch(() => {}) }
})
it('keeps a timed-out native end distinct from acknowledged flush and ignores late replies', async () => {
  vi.useFakeTimers(); const f = fixture(); f.state.completeOnEnd = false
  let end!: (value: object) => void; f.state.end = () => new Promise(resolve => { end = resolve })
  const pending = f.tracer.capture(input()); await vi.advanceTimersByTimeAsync(61_000)
  const result = await pending, saved = structuredClone(result)
  expect(result.status).toBe('unknown'); expect(result.lifecycle.endAcknowledged).toBe(false)
  expect(result.lifecycle.tracingComplete).toBe(false); expect(result.issues[0]!.code).toBe('CONTROL_TIMEOUT')
  end({}); f.complete(); await vi.advanceTimersByTimeAsync(0); expect(result).toEqual(saved)
})
it('validates exact target and stream/lifecycle counters without pretending the wire parser inflated the bytes', async () => {
  vi.useFakeTimers(); const result = await finish(fixture())
  expect(parseRendererTraceResult(result, input())).toBe(result)
  expect(() => parseRendererTraceResult(result, { ...input(), target: { ...target, pid: 99 } })).toThrow()
  expect(() => parseRendererTraceResult({ ...result, lifecycle: { ...result.lifecycle, tracingComplete: false } })).toThrow()
  expect(() => parseRendererTraceResult({ ...result, stream: { ...result.stream, eof: false } })).toThrow()
  expect(() => parseRendererTraceResult({ ...result, receivedGzipBytes: result.receivedGzipBytes + 1 })).toThrow()
  expect(() => parseRendererTraceInput({ ...input(), durationMs: 999 })).toThrow()
  expect(agentMuxControlTimeoutMs('metrics.trace.capture')).toBe(60_000)
})
it('releases the real tracer when the original metrics port is disposed', async () => {
  vi.useFakeTimers(); const f = fixture(), port = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => target, tracer: f.tracer })
  const pending = port.captureTrace!(input()); await vi.advanceTimersByTimeAsync(0); port.dispose()
  await vi.advanceTimersByTimeAsync(1100)
  expect((await pending).status).toBe('unknown')
  await expect(port.captureTrace!(input())).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})

async function completed(): Promise<RendererTraceResult> { vi.useFakeTimers(); const result = await finish(fixture()); vi.useRealTimers(); return result }
it('verifies both checksums, writes original raw bytes and never replaces existing files or symlinks', async () => {
  const capture = await completed(), directory = await mkdtemp(join(tmpdir(), 'renderer-trace-files-')); disposers.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'trace.json'), receipt = await writeRendererTrace(path, { capture })
  expect(Buffer.compare(await readFile(path), nativeJSON())).toBe(0); expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(receipt.sha256).toBe(capture.sha256); expect(receipt.bytes).toBe(capture.traceBytes)
  await expect(writeRendererTrace(path, { capture })).rejects.toMatchObject({ code: 'EEXIST' })
  const linked = join(directory, 'linked.json'); await symlink(path, linked)
  await expect(writeRendererTrace(linked, { capture })).rejects.toMatchObject({ code: 'EEXIST' })
  await expect(writeRendererTrace(join(directory, 'bad-raw.json'), { capture: { ...capture, sha256: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  await expect(writeRendererTrace(join(directory, 'bad-gzip.json'), { capture: { ...capture, trace: { ...capture.trace!, sha256: '0'.repeat(64) } } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
})
it('retains the original V8 writer contract after extracting its atomic publishing leaf', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-profile-writer-')); disposers.push(() => rm(directory, { recursive: true, force: true }))
  const profile = { nodes: [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 } }], startTime: 1, endTime: 2 }
  const capture = { ...input(), schema: 'agentmux.renderer-v8-profile.v1', scope: 'renderer-main-thread-v8', status: 'completed',
    timing: { requestedAt: _historyFixtureEpoch(0, 0, 1), startedAt: _historyFixtureEpoch(0, 0, 1), stoppedAt: _historyFixtureEpoch(0, 0, 2), finishedAt: _historyFixtureEpoch(0, 0, 2), startMonotonicMs: 1, stopMonotonicMs: 2 }, profilerTimeUnit: 'microseconds',
    sourceVerified: { before: true, after: true }, cleanup: { stopRequested: true, stopAcknowledged: true, disableAcknowledged: true, detached: 'confirmed' },
    profile, profileBytes: Buffer.byteLength(JSON.stringify(profile)), sha256: createHash('sha256').update(JSON.stringify(profile)).digest('hex'), issues: [] }
  const path = join(directory, 'original.cpuprofile'); await writeRendererV8Profile(path, { capture })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(profile)
  await expect(writeRendererV8Profile(path, { capture })).rejects.toMatchObject({ code: 'EEXIST' })
})
it('delivers a raw trace larger than the old 8 MiB limit through actual tracer, metrics, Unix and compiled public CLI exactly once per request', async () => {
  const root = resolve(import.meta.dirname, '../../..'), directory = join(process.env.PROFILE_UNIT_OUTPUT!, 'port-cli')
  await mkdir(directory, { recursive: true })
  const frozen = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(readFileSync(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) : {}
  const executable = await compileRendererProfileCli(root, directory, frozen, process.env.AGENTMUX_PERFORMANCE_LOADED)
  const f = fixture()
  f.state.raw = Buffer.from('{\n"metadata":{"original":"λ"},"traceEvents":' + JSON.stringify([
    ...originalEvents(), { pid: 4, tid: 8, ph: 'i', ts: 5, name: 'original-large-argument', args: { text: 'x'.repeat(RENDERER_TRACE_MAX_BYTES + 1024) } }
  ]) + '\n}\n')
  f.state.chunkBytes = 1024
  expect(f.state.raw.length).toBeGreaterThan(RENDERER_TRACE_MAX_BYTES)
  const captureTrace = vi.spyOn(f.tracer, 'capture'), execute = vi.fn(async () => { throw new Error('Renderer fallback must not execute') })
  const port = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => target, tracer: f.tracer })
  const service = new AgentMuxRpcService({ execute, metrics: port })
  const args = ['system', 'metrics', 'trace', 'capture', ...Object.entries({ '--window-id': 1, '--web-contents-id': 2, '--generation': 3, '--pid': 4, '--creation-time': 1000, '--duration-ms': 1000 }).flatMap(([key, value]) => [key, String(value)])]
  const parsed = await parseAgentMuxCliInvocation(args)
  expect(parsed.command.method).toBe('system.metrics.trace.capture'); expect(parsed.params).toEqual(input())
  const body = await service.call('system.metrics.trace.capture', parsed.params as never, { principal: { kind: 'device', id: 'private-device' } })
  expect(parseRpcControlResult('system.metrics.trace.capture', body, parsed.params)).toEqual(body)
  expect(rpcControlRequest('system.metrics.trace.capture', parsed.params)).toMatchObject({ operation: 'metrics.trace.capture', ...input() })
  expect(() => parseRpcControlResult('system.metrics.trace.capture', body, { ...parsed.params, target: { ...target, generation: 4 } })).toThrow()
  const socketPath = join(process.env.PROFILE_NAMESPACE!, 'trace.sock'), server = new AgentMuxControlServer({ coreClients: () => [], metrics: port }, socketPath)
  await server.start(); disposers.push(() => server.stop())
  async function cli(extra: string[]) {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', process.env.PROFILE_PRE_IMPORT_MODULE!, executable, '--endpoint', 'unix://' + socketPath, ...args, ...extra], {
        env: { ...process.env, PROFILE_PRE_IMPORT: join(directory, 'cli-pre-import-' + captureTrace.mock.calls.length + '.json') }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
      child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }))
    })
  }
  const output = join(directory, 'trace.json'), before = captureTrace.mock.calls.length
  const first = await cli(['--output', output])
  await writeFile(join(directory, 'first-cli.json'), JSON.stringify(first))
  expect(first.code, 'Raw public CLI reply: first-cli.json; stderr: ' + first.stderr.slice(0, 2048)).toBe(0)
  const original = await captureTrace.mock.results[before]!.value, wire = JSON.parse(first.stdout)
  expect(wire).toMatchObject({ ok: true, result: { capture: original }, output: { sha256: original.sha256, bytes: f.state.raw.length } })
  expect(wire.result.capture).toEqual(original); expect(original.target).toEqual(target)
  expect(original.sourceVerified).toEqual({ before: true, after: true })
  expect(original.stream).toEqual({ handleReceived: true, eof: true, closeRequested: true, closeAcknowledged: true })
  expect(original.status).toBe('completed'); expect(original.receivedEvents).toBe(3)
  expect(original.traceBytes).toBe(f.state.raw.length); expect(original.sha256).toBe(sha(f.state.raw))
  expect(original.trace!.bytes).toBe(gzipSync(f.state.raw).length); expect(original.trace!.sha256).toBe(sha(gzipSync(f.state.raw)))
  expect(Buffer.byteLength(first.stdout)).toBeLessThan(RENDERER_TRACE_MAX_BYTES)
  expect(Buffer.compare(await readFile(output), f.state.raw)).toBe(0)
  const failed = await cli(['--output', output])
  await writeFile(join(directory, 'existing-output-cli.json'), JSON.stringify(failed))
  expect(failed.code, 'Raw public CLI reply: existing-output-cli.json; stderr: ' + failed.stderr.slice(0, 2048)).toBe(1)
  const second = await captureTrace.mock.results[before + 1]!.value
  expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, result: { capture: second }, outputError: { code: 'EEXIST' } })
  expect(captureTrace.mock.calls.length - before).toBe(2)
  expect(methods(f).filter(method => method === 'Tracing.start')).toHaveLength(before + 2)
  expect(methods(f).filter(method => method === 'Tracing.end')).toHaveLength(before + 2)
  expect(methods(f).filter(method => method === 'IO.close')).toHaveLength(before + 2)
  expect(f.state.maxActiveReads).toBe(1); expect(execute).not.toHaveBeenCalled()
  await expect(new AgentMuxRpcService({ execute }).call('system.metrics.trace.capture', input())).rejects.toMatchObject({ code: 'METRICS_UNSUPPORTED' })
}, 30_000)
