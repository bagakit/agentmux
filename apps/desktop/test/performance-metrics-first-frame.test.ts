import { appendFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { parseMetricsObservation, type MetricsObservation, type MetricsWindow } from '@agentmux/core/control'
import { rendererMemoryFixture } from '../../../packages/core/test/helpers/toolkit-metrics.js'
import { performanceFixture } from '../../../packages/core/test/helpers/renderer-performance.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'
import { createResourceMetricsPort, observeRendererResources } from '../src/main/resource-usage-control.js'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const pending = { state: 'pending', data: null, observedAt: null, lastSuccessAt: null, reason: null }
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve() }
function state(sampler: ProcessResourceSampler) {
  const owner = sampler as unknown as { subscribers: Set<unknown>; timer: unknown }
  return { consumers: owner.subscribers.size, timer: owner.timer !== null }
}
function evidence(value: unknown) {
  const path = process.env.AGENTMUX_TERMINAL_INPUT_LOADED
  if (path) appendFileSync(path + '.first-frame', JSON.stringify(value) + '\n')
}
function harness() {
  let clock = 1000
  let window: MetricsWindow | null = { windowId: 7, webContentsId: 919, generation: 0 }
  const requests: any[] = []
  const cancel = vi.fn()
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true,
    sendRequest: request => { requests.push(request) }, sendCancellation: cancel })
  const read = vi.fn(async () => 'PID PPID RSS %CPU\n100 1 64 2')
  const sampler = new ProcessResourceSampler(read, () => clock, () => [{ pid: 300, creationTime: 1,
    type: 'Tab', memory: { workingSetSize: 1024 }, cpu: { percentCPUUsage: 0, cumulativeCPUUsage: clock / 10_000 }
  }] as Electron.ProcessMetric[], () => clock)
  sampler.trackRun('preserved-run', 100, 'local')
  sampler.setObservationSources({ rendererWindow: () => window,
    observeRenderer: signal => observeRendererResources(bridge, () => window, signal, () => 300),
    observeRuntime: async () => [], processOwners: () => ({ rendererPids: [300], browserPids: [] }),
    mainOwners: () => ({ sessionAttachmentOwners: 1, sessionAttachmentLeases: 1, fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }) })
  const port = createResourceMetricsPort({ sampler, currentWindow: () => window, now: () => clock })
  cleanup.push(() => { port.dispose(); sampler.dispose(); bridge.dispose() })
  const watch = async () => {
    const values: MetricsObservation[] = [], controller = new AbortController(), ended = vi.fn()
    const subscription = await port.subscribe(value => values.push(parseMetricsObservation(value)), ended, controller.signal)
    await flush()
    return { values, controller, ended, subscription, latest: () => values.at(-1)! }
  }
  const answer = (request = requests.at(-1), observedAt = clock) => bridge.accept({ requestId: request.requestId, ok: true,
    result: { operation: 'metrics.renderer', window: request.window, observedAt, ...rendererMemoryFixture(300),
      counts: { monacoEditors: 0, monacoModels: 0, documents: 0, runtimeSubscriptions: 1, terminalViews: 1, terminalAddons: 0, terminalListeners: 0 },
      performance: performanceFixture() } })
  const fail = (request = requests.at(-1)) => bridge.accept({ requestId: request.requestId, ok: false,
    error: { code: 'CONTROL_UNAVAILABLE', message: 'Actual Renderer reader failed' } })
  return { sampler, port, bridge, read, requests, cancel, watch, answer, fail,
    window: () => window, replaceWindow: (value: MetricsWindow | null) => { window = value },
    advance: (ms: number) => { clock += ms } }
}
async function publicOwner(h: ReturnType<typeof harness>) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-first-frame-')), path = join(directory, 'control.sock')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ coreClients: () => [], execute: vi.fn(), metrics: h.port }, path)
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  cleanup.push(() => rpc.dispose())
  return { directory, path, rpc }
}

describe('actual sampler and Renderer bridge first-frame source', () => {
  it('keeps a process-first frame pending until the actual same-window answer, preserving source times', async () => {
    vi.useFakeTimers()
    const h = harness(), watch = await h.watch()
    expect(h.requests).toHaveLength(1)
    expect(watch.latest().process).toMatchObject({ state: 'available', observedAt: 1000, data: [{ runId: 'preserved-run' }] })
    expect(watch.latest().renderer).toEqual(pending)
    h.advance(200); expect(h.answer(undefined, 1190)).toBe(true); await flush()
    expect(watch.latest().renderer).toMatchObject({ state: 'available', observedAt: 1190, lastSuccessAt: 1190, reason: null,
      data: { window: { windowId: 7, webContentsId: 919, generation: 0 } } })
    expect(watch.latest().process.observedAt).toBe(1000)
    evidence({ case: 'process-first-renderer-later', first: watch.values[0], final: watch.latest() })
    watch.subscription.dispose()
  })

  it('reports a real bridge deadline as unavailable rather than pending', async () => {
    vi.useFakeTimers()
    const h = harness(), watch = await h.watch()
    expect(watch.latest().renderer).toEqual(pending)
    await vi.advanceTimersByTimeAsync(2000)
    expect(watch.latest().renderer).toEqual({ state: 'unavailable', data: null, observedAt: null, lastSuccessAt: null,
      reason: 'Desktop Control request timed out.' })
    expect(watch.latest().process.state).toBe('available')
    expect(h.cancel).toHaveBeenCalled()
    watch.subscription.dispose()
  })

  it('keeps same-window success stale with its original success age after actual failure', async () => {
    vi.useFakeTimers()
    const h = harness(), watch = await h.watch()
    h.answer(); await flush()
    h.advance(1000); await vi.advanceTimersByTimeAsync(1000)
    expect(h.requests).toHaveLength(2)
    h.fail(); await flush()
    expect(watch.latest().renderer).toMatchObject({ state: 'stale', observedAt: 1000, lastSuccessAt: 1000,
      reason: 'Actual Renderer reader failed', data: { window: h.window() } })
    expect(watch.latest().process.observedAt).toBe(2000)
    watch.subscription.dispose()
  })

  it.each(['windowId', 'webContentsId', 'generation'] as const)('does not attribute an old in-flight %s failure to its replacement', async field => {
    vi.useFakeTimers()
    const h = harness(), watch = await h.watch(), old = h.requests[0]
    // Mutate the original identity object too: attempted identity must have been captured by value.
    h.window()![field]++
    expect(h.fail(old)).toBe(true); await flush()
    expect(watch.latest().renderer).toEqual(pending)
    h.advance(1000); await vi.advanceTimersByTimeAsync(1000)
    expect(h.requests).toHaveLength(2)
    expect(h.fail()).toBe(true); await flush()
    expect(watch.latest().renderer).toEqual({ state: 'unavailable', data: null, observedAt: null, lastSuccessAt: null,
      reason: 'Actual Renderer reader failed' })
    watch.subscription.dispose()
  })

  it('does not let old success data hide an actual new-window failure or sign the new window', async () => {
    vi.useFakeTimers()
    const h = harness(), watch = await h.watch()
    h.answer(); await flush()
    h.replaceWindow({ ...h.window()!, generation: 1 })
    h.advance(1000); await vi.advanceTimersByTimeAsync(1000)
    expect(watch.latest().renderer).toEqual(pending)
    h.fail(); await flush()
    expect(watch.latest().renderer).toEqual({ state: 'unavailable', data: null, observedAt: null, lastSuccessAt: null,
      reason: 'Actual Renderer reader failed' })
    expect(watch.latest().window?.generation).toBe(1)
    watch.subscription.dispose()
  })

  it('rejects a late success from an ended window and records only the original attempt failure', async () => {
    vi.useFakeTimers()
    const h = harness(), watch = await h.watch(), old = h.requests[0]
    h.replaceWindow({ ...h.window()!, generation: 1 })
    h.answer(old); await flush()
    expect(watch.latest().renderer).toEqual(pending)
    h.advance(1000); await vi.advanceTimersByTimeAsync(1000)
    h.answer(); await flush()
    expect(watch.latest().renderer).toMatchObject({ state: 'available', data: { window: { generation: 1 } } })
    watch.subscription.dispose()
  })

  it('keeps a missing current window explicitly unavailable', async () => {
    vi.useFakeTimers()
    const h = harness(); h.replaceWindow(null)
    const watch = await h.watch()
    expect(watch.latest().renderer).toEqual({ state: 'unavailable', data: null, observedAt: null, lastSuccessAt: null,
      reason: 'Current Renderer window is unavailable' })
    watch.subscription.dispose()
  })

  it('releases the last reader, cancels its actual bridge and never imports old replies on reopen', async () => {
    vi.useFakeTimers()
    const h = harness(), first = await h.watch(), old = h.requests[0]
    first.subscription.dispose(); await flush()
    expect(state(h.sampler)).toEqual({ consumers: 0, timer: false })
    expect(h.cancel).toHaveBeenCalledTimes(1)
    const second = await h.watch()
    expect(h.answer(old)).toBe(false)
    expect(h.requests).toHaveLength(2)
    expect(second.latest().renderer).toEqual(pending)
    h.answer(); await flush()
    expect(second.latest().renderer.state).toBe('available')
    second.subscription.dispose(); await flush()
    const reads = h.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.read).toHaveBeenCalledTimes(reads)
    expect(state(h.sampler)).toEqual({ consumers: 0, timer: false })
  })
})

describe('actual Unix and compiled CLI consumers of the sampler port', () => {
  it('returns the first pending get frame then releases its exact reader before Renderer settles', async () => {
    const h = harness(), f = await publicOwner(h)
    const result = await f.rpc.call('system.metrics.get', {})
    expect(result.observation.renderer).toEqual(pending)
    expect(result.observation.process.data).toHaveLength(1)
    await flush()
    expect(state(h.sampler)).toEqual({ consumers: 0, timer: false })
    expect(h.cancel).toHaveBeenCalledTimes(1)
    expect(h.answer(h.requests[0])).toBe(false)
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + f.path, 'system', 'metrics', 'get'], objectCliEnvironment(f.directory))
    expect(cli.code).toBe(0); expect(cli.stderr).toBe('')
    expect(JSON.parse(cli.stdout).result.observation.renderer).toEqual(pending)
    await flush()
    expect(state(h.sampler)).toEqual({ consumers: 0, timer: false })
    expect(h.cancel).toHaveBeenCalledTimes(2)
    evidence({ case: 'actual-unix-and-compiled-get-first-frame', rpc: result, cli: JSON.parse(cli.stdout), finalOwner: state(h.sampler) })
  })

  it('shares watch leases with CLI get and distinguishes source samples from transport frames', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const h = harness(), f = await publicOwner(h), values: MetricsObservation[] = []
    const options = { onInitial(value: { observation: MetricsObservation }) { values.push(value.observation) },
      onEvent(value: { type: string; data?: unknown }) { if (value.type === 'snapshot') values.push(parseMetricsObservation(value.data)) } }
    const first = await f.rpc.subscribe('system.metrics.watch', {}, options)
    const second = await f.rpc.subscribe('system.metrics.watch', {}, options)
    expect(state(h.sampler)).toEqual({ consumers: 2, timer: true })
    expect(values.at(-1)!.renderer).toEqual(pending)
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + f.path, 'system', 'metrics', 'get'], objectCliEnvironment(f.directory))
    expect(cli.code).toBe(0); expect(cli.stderr).toBe('')
    expect(JSON.parse(cli.stdout).result.observation.renderer).toEqual(pending)
    expect(state(h.sampler)).toEqual({ consumers: 2, timer: true })
    expect(h.requests).toHaveLength(1); expect(h.cancel).not.toHaveBeenCalled()
    const appTime = values.at(-1)!.app.observedAt
    expect(values.at(-1)!.app.data!.processes[0]!.intervalMs).toBeNull()
    h.answer(); await vi.waitFor(() => expect(values.at(-1)!.renderer.state).toBe('available'))
    expect(values.at(-1)!.app.observedAt).toBe(appTime)
    h.advance(1000); await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(values.at(-1)!.app.observedAt).toBe(2000))
    expect(values.at(-1)!.app.data!.processes[0]).toMatchObject({ intervalMs: 1000, cpuPercent: 10 })
    await first.dispose(); await vi.waitFor(() => expect(state(h.sampler).consumers).toBe(1))
    expect(h.cancel).not.toHaveBeenCalled()
    await second.dispose(); await vi.waitFor(() => expect(state(h.sampler)).toEqual({ consumers: 0, timer: false }))
    expect(h.cancel).toHaveBeenCalledTimes(1)
    evidence({ case: 'shared-real-watch-and-cli-get', values, reads: h.read.mock.calls.length, finalOwner: state(h.sampler) })
  })
})
