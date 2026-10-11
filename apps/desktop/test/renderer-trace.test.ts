import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
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
  parseRendererTraceEvents, parseRendererTraceResult, rendererTraceJSON, type RendererTraceResult } from '../../../packages/core/src/renderer-trace'
import { writeRendererTrace } from '../../../packages/core/src/renderer-trace-cli'
import { writeRendererV8Profile } from '../../../packages/core/src/renderer-v8-profile-cli'
import { compileRendererProfileCli } from '../../../packages/core/test/helpers/renderer-profile-cli'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const target = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }
const input = (durationMs = 1000) => ({ target: { ...target }, durationMs })
const originalEvents = () => [{ pid: 4, tid: 8, ph: 'X', ts: 1.5, dur: 2, name: 'Layout', cat: 'devtools.timeline',
  args: { original: { text: 'λ', list: [null, true, 3], futureField: { retained: 'exact' } } } },
  { pid: 4, tid: 8, ph: 'i', ts: 4, name: 'private-timeline-marker', cat: 'blink.user_timing', args: {} }]
const disposers: Array<() => void | Promise<void>> = []
function fixture() {
  let current: typeof target | null = { ...target }
  const state = { attached: false, devtools: false, destroyed: false, nativeForeignTrace: false,
    start: () => Promise.resolve({}), end: () => Promise.resolve({}), completeOnEnd: true, dataLoss: false,
    batches: [originalEvents()], onEnd: () => {} }
  const debuggerClient = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => state.attached),
    attach: vi.fn(() => { if (state.attached) throw new Error('Already attached'); state.attached = true }),
    detach: vi.fn(() => { state.attached = false; debuggerClient.emit('detach') }),
    sendCommand: vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
      if (method === 'Tracing.start') {
        if (state.nativeForeignTrace) throw new Error('Tracing has already been started in another tab.')
        return state.start()
      }
      if (method === 'Tracing.end') {
        state.onEnd()
        for (const value of state.batches) debuggerClient.emit('message', {}, 'Tracing.dataCollected', { value })
        if (state.completeOnEnd) debuggerClient.emit('message', {}, 'Tracing.tracingComplete', { dataLossOccurred: state.dataLoss })
        return state.end()
      }
      return {}
    })
  })
  const contents = Object.assign(new EventEmitter(), { debugger: debuggerClient, isDestroyed: () => state.destroyed,
    isDevToolsOpened: () => state.devtools })
  const tracer = new RendererTimelineTracer(contents as unknown as WebContents, () => current)
  disposers.push(() => tracer.dispose())
  return { tracer, state, contents, debuggerClient, setCurrent(value: typeof target | null) { current = value },
    complete() { debuggerClient.emit('message', {}, 'Tracing.tracingComplete', { dataLossOccurred: state.dataLoss }) } }
}
async function finish(f: ReturnType<typeof fixture>, duration = 1000) {
  const pending = f.tracer.capture(input(duration)); await vi.advanceTimersByTimeAsync(duration); return pending
}
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); vi.useRealTimers(); vi.restoreAllMocks() })

it.each([1000, 5000])('preserves complete ordered original ReportEvents for %i ms and owns start/end/flush/detach separately', async duration => {
  vi.useFakeTimers(); const f = fixture(), extra = { pid: 10, tid: 9, ph: 'M', ts: 5, name: 'process_name', args: { name: 'related context' } }
  f.state.batches = [originalEvents(), [extra] as never]
  const result = await finish(f, duration)
  expect(result.status).toBe('completed'); expect(result.trace!.traceEvents).toEqual([...originalEvents(), extra])
  expect(result.lifecycle).toEqual({ startRequested: true, startAcknowledged: true, endRequested: true,
    endAcknowledged: true, tracingComplete: true, dataLossOccurred: false, detached: 'confirmed' })
  expect(result.sourceVerified).toEqual({ before: true, after: true })
  expect(result.timing.endMonotonicMs! - result.timing.startMonotonicMs!).toBeGreaterThanOrEqual(duration)
  expect(result.traceBytes).toBe(Buffer.byteLength(JSON.stringify(result.trace)))
  expect(result.sha256).toBe(createHash('sha256').update(JSON.stringify(result.trace)).digest('hex'))
  expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Tracing.start', 'Tracing.end'])
  expect(f.debuggerClient.sendCommand.mock.calls[0]![1]).toEqual({ transferMode: 'ReportEvents', bufferUsageReportingInterval: 250,
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
it('does not end a foreign native trace after its own start was rejected', async () => {
  const f = fixture(); f.state.nativeForeignTrace = true
  const outcome = await f.tracer.capture(input()).then(result => ({ result, error: null }), error => ({ result: null, error }))
  expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Tracing.start'])
  expect(f.state.nativeForeignTrace).toBe(true)
  expect(outcome.error).toBeNull()
  const result = outcome.result!
  expect(result.status).toBe('failed'); expect(result.lifecycle.startAcknowledged).toBe(false)
  expect(result.lifecycle.endRequested).toBe(false); expect(result.lifecycle.tracingComplete).toBe(false)
  expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Tracing.start'])
  expect(f.state.nativeForeignTrace).toBe(true); expect(result.lifecycle.detached).toBe('confirmed')
})
it('requires the real flush event after end ACK; it cannot complete early', async () => {
  vi.useFakeTimers(); const f = fixture(); f.state.completeOnEnd = false
  let settled = false
  const pending = f.tracer.capture(input()); void pending.then(() => { settled = true }, () => { settled = true })
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Tracing.start', 'Tracing.end'])
  expect(settled).toBe(false)
  f.complete(); const result = await pending
  expect(result.lifecycle.endAcknowledged).toBe(true); expect(result.lifecycle.tracingComplete).toBe(true)
})
it('keeps pending start cancellation unknown, never ends it, and ignores its late ACK', async () => {
  vi.useFakeTimers(); const f = fixture(), signal = new AbortController()
  let resolveStart!: (value: object) => void
  f.state.start = () => new Promise(resolve => { resolveStart = resolve })
  let settled = false
  const pending = f.tracer.capture(input(), signal.signal); void pending.then(() => { settled = true }, () => { settled = true })
  try {
    await vi.advanceTimersByTimeAsync(0); signal.abort(); await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    const result = await pending, saved = structuredClone(result)
    expect(result.status).toBe('unknown'); expect(result.lifecycle.startAcknowledged).toBe(false)
    expect(result.lifecycle.endRequested).toBe(false); expect(result.lifecycle.detached).toBe('confirmed')
    resolveStart({}); await vi.advanceTimersByTimeAsync(0)
    expect(result).toEqual(saved); expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Tracing.start'])
  } finally { signal.abort(); resolveStart({}); await vi.advanceTimersByTimeAsync(1000); await pending.catch(() => {}) }
})
it('ends its acknowledged recording once on cancellation without inventing end or flush ACK', async () => {
  vi.useFakeTimers(); const f = fixture(), signal = new AbortController()
  const pending = f.tracer.capture(input(), signal.signal); await vi.advanceTimersByTimeAsync(0); signal.abort()
  const result = await pending
  expect(result.status).toBe('unknown'); expect(result.lifecycle.endRequested).toBe(true)
  expect(result.lifecycle.endAcknowledged).toBe(false); expect(result.lifecycle.tracingComplete).toBe(false)
  expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Tracing.start', 'Tracing.end'])
  expect(result.lifecycle.detached).toBe('confirmed')
})
it('does not detach or end a new foreign debugger after owner loss', async () => {
  vi.useFakeTimers(); const f = fixture(), pending = f.tracer.capture(input())
  await vi.advanceTimersByTimeAsync(0); f.state.attached = false; f.debuggerClient.emit('detach'); f.state.attached = true
  const result = await pending
  expect(result.status).toBe('unknown'); expect(result.lifecycle.detached).toBe('owner-lost')
  expect(f.debuggerClient.detach).not.toHaveBeenCalled(); expect(f.state.attached).toBe(true)
  expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Tracing.start'])
})
it('rejects a changed source even if the original end and flush arrived', async () => {
  vi.useFakeTimers(); const f = fixture()
  f.state.onEnd = () => { f.setCurrent({ ...target, generation: target.generation + 1 }); f.contents.emit('did-start-navigation') }
  const result = await finish(f)
  expect(result.status).toBe('unknown'); expect(result.sourceVerified.after).toBe(false); expect(result.trace).toBeNull()
})
it('does not convert data loss or an observed full buffer into complete coverage', async () => {
  vi.useFakeTimers(); const f = fixture(); f.state.dataLoss = true
  const result = await finish(f)
  expect(result.status).toBe('failed'); expect(result.lifecycle.dataLossOccurred).toBe(true)
  expect(result.trace!.traceEvents).toEqual(originalEvents()); expect(result.issues[0]!.stage).toBe('data-loss')
  const g = fixture(), pending = g.tracer.capture(input()); await vi.advanceTimersByTimeAsync(0)
  g.debuggerClient.emit('message', {}, 'Tracing.bufferUsage', { percentFull: 1 })
  await vi.advanceTimersByTimeAsync(1000)
  const full = await pending; expect(full.status).toBe('failed'); expect(full.bufferUsage.fullObserved).toBe(true)
})
it('rejects oversize while collecting and returns byte facts without a truncated trace', async () => {
  vi.useFakeTimers(); const f = fixture()
  f.state.batches = [[{ pid: 4, tid: 8, ph: 'i', ts: 1, name: 'large', args: { text: 'x'.repeat(RENDERER_TRACE_MAX_BYTES) } }] as never]
  const result = await finish(f)
  expect(result.status).toBe('failed'); expect(result.receivedTraceBytes).toBeGreaterThan(RENDERER_TRACE_MAX_BYTES)
  expect(result.trace === null).toBe(true); expect(result.lifecycle.endAcknowledged).toBe(false)
})
it('keeps a timed-out native end distinct from acknowledged flush and ignores late replies', async () => {
  vi.useFakeTimers(); const f = fixture(); f.state.completeOnEnd = false
  let end!: (value: object) => void; f.state.end = () => new Promise(resolve => { end = resolve })
  const pending = f.tracer.capture(input()); await vi.advanceTimersByTimeAsync(60_000)
  const result = await pending, saved = structuredClone(result)
  expect(result.status).toBe('unknown'); expect(result.lifecycle.endAcknowledged).toBe(false)
  expect(result.lifecycle.tracingComplete).toBe(false); expect(result.issues[0]!.code).toBe('CONTROL_TIMEOUT')
  end({}); f.complete(); await vi.advanceTimersByTimeAsync(0); expect(result).toEqual(saved)
})
it('validates exact target, complete lifecycle and arbitrary original JSON without normalizing it', async () => {
  vi.useFakeTimers(); const result = await finish(fixture())
  expect(parseRendererTraceResult(result, input())).toBe(result)
  expect(() => parseRendererTraceResult(result, { ...input(), target: { ...target, pid: 99 } })).toThrow()
  expect(() => parseRendererTraceResult({ ...result, lifecycle: { ...result.lifecycle, tracingComplete: false } })).toThrow()
  expect(() => parseRendererTraceInput({ ...input(), durationMs: 999 })).toThrow()
  expect(() => parseRendererTraceEvents([{ invalid: undefined }])).toThrow()
  expect(() => parseRendererTraceEvents([{ value: Number.NaN }])).toThrow()
  expect(() => rendererTraceJSON({ traceEvents: [{ text: 'λ'.repeat(RENDERER_TRACE_MAX_BYTES / 2) }] })).toThrow(/8 MiB/)
  expect(agentMuxControlTimeoutMs('metrics.trace.capture')).toBe(60_000)
})
it('releases the real tracer when the original metrics port is disposed', async () => {
  vi.useFakeTimers(); const f = fixture(), port = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => target, tracer: f.tracer })
  const pending = port.captureTrace!(input()); await vi.advanceTimersByTimeAsync(0); port.dispose()
  await vi.advanceTimersByTimeAsync(1000)
  expect((await pending).status).toBe('unknown')
  await expect(port.captureTrace!(input())).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})

async function completed(): Promise<RendererTraceResult> { vi.useFakeTimers(); const result = await finish(fixture()); vi.useRealTimers(); return result }
it('verifies checksum and never replaces existing files or symlinks through the shared atomic writer', async () => {
  const capture = await completed(), directory = await mkdtemp(join(tmpdir(), 'renderer-trace-files-')); disposers.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'trace.json'), receipt = await writeRendererTrace(path, { capture })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(capture.trace); expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(receipt.sha256).toBe(capture.sha256)
  await expect(writeRendererTrace(path, { capture })).rejects.toMatchObject({ code: 'EEXIST' })
  const linked = join(directory, 'linked.json'); await symlink(path, linked)
  await expect(writeRendererTrace(linked, { capture })).rejects.toMatchObject({ code: 'EEXIST' })
  await expect(writeRendererTrace(join(directory, 'bad.json'), { capture: { ...capture, sha256: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
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
it('connects the real public CLI/RPC codecs to the original metrics port and never recaptures after a local output failure', async () => {
  const root = resolve(import.meta.dirname, '../../..'), directory = join(process.env.PROFILE_UNIT_OUTPUT!, 'port-cli')
  await mkdir(directory, { recursive: true })
  const frozen = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(readFileSync(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) : {}
  const executable = await compileRendererProfileCli(root, directory, frozen, process.env.AGENTMUX_PERFORMANCE_LOADED)
  const capture = await completed(), captureTrace = vi.fn(async () => capture)
  const port = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => target, tracer: { capture: captureTrace, dispose() {} } })
  const service = new AgentMuxRpcService({ execute: async () => { throw new Error('Renderer fallback must not execute') }, metrics: port })
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
  const first = await cli(['--output', output]); expect(first.code).toBe(0)
  await writeFile(join(directory, 'first-cli.json'), JSON.stringify(first))
  expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, result: { capture }, output: { sha256: capture.sha256 } })
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(capture.trace)
  const failed = await cli(['--output', output]); expect(failed.code).toBe(1)
  await writeFile(join(directory, 'existing-output-cli.json'), JSON.stringify(failed))
  expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, result: { capture }, outputError: { code: 'EEXIST' } })
  expect(captureTrace.mock.calls.length - before).toBe(2)
  await expect(new AgentMuxRpcService({ execute: async () => { throw new Error('Must not execute') } }).call('system.metrics.trace.capture', input())).rejects.toMatchObject({ code: 'METRICS_UNSUPPORTED' })
})
