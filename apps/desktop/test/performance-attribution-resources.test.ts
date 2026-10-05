// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import ts from 'typescript'
import { ProcessResourceSampler, type ResourceSample } from '../src/main/process-resource-sampler'
import { createResourceMetricsPort, observeRendererResources } from '../src/main/resource-usage-control'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { parseMetricsObservation } from '../../../packages/core/src/metrics'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseToolkitSnapshot } from '../../../packages/core/src/toolkit'
import { deepMetricsSnapshot, rendererMemoryFixture } from '../../../packages/core/test/helpers/toolkit-metrics'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api'
import { createRendererHistoryObservation } from '../src/renderer/src/lib/history-observation'
import { createRendererSessionEvents } from '../src/renderer/src/lib/session-events'
import { unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'

declare const __AGENTMUX_RESOURCE_STORE_SOURCE__: string
declare const __AGENTMUX_RESOURCE_API_SOURCE__: string
const native = vi.hoisted(() => ({ api: undefined as AgentMuxPreloadApi | undefined }))
vi.mock('electron', () => ({ app: { getAppMetrics: () => [] }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), send: vi.fn() },
  webFrame: {}, contextBridge: { exposeInMainWorld(_name: string, api: AgentMuxPreloadApi) { native.api = api; (window as any).agentmux = api } } }))

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs()
})
function metric(pid: number, seconds: number | undefined, rss = 100, creationTime = 1): Electron.ProcessMetric {
  return { pid, creationTime, type: 'Tab', memory: { workingSetSize: rss, peakWorkingSetSize: rss },
    cpu: { percentCPUUsage: 999, cumulativeCPUUsage: seconds, idleWakeupsPerSecond: 0 } }
}
function harness(initial = [metric(10, 0), metric(20, 0, 200)]) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let mono = 0, wall = 1000, metrics = initial, reads = 0, nativeReads = 0, capacityReads = 0
  const sampler = new ProcessResourceSampler(async () => { reads++; return 'PID PPID RSS %CPU\n1 0 1 0' },
    () => wall, () => { nativeReads++; return metrics }, () => mono, () => { capacityReads++; return 14 })
  sampler.setObservationSources({ observeRuntime: async () => [], processOwners: () => ({ rendererPids: metrics.map(row => row.pid), browserPids: [] }),
    mainOwners: () => ({ sessionAttachmentOwners: 0, sessionAttachmentLeases: 0, fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }) })
  cleanup.push(() => sampler.dispose())
  const snapshots: ResourceSample[] = []
  const off = sampler.subscribe(value => snapshots.push(value))
  const sample = async (next = metrics, at = mono + 1000) => {
    metrics = next; mono = at; wall -= 100
    await (sampler as unknown as { sampleOnce(): Promise<void> }).sampleOnce()
    expect(snapshots.length).toBeGreaterThan(0)
    return snapshots.at(-1)!.app!
  }
  return { sampler, off, snapshots, sample, get reads() { return reads }, get nativeReads() { return nativeReads }, get capacityReads() { return capacityReads } }
}

it('projects the same native batch with interval CPU, full group RSS and one cached logical capacity', async () => {
  const f = harness()
  const first = await f.sample()
  expect(first.processes).toHaveLength(2)
  expect(first.processes[0]).toMatchObject({ cpuPercent: null, intervalMs: null })
  const next = await f.sample([metric(10, 1, 123), metric(20, .5, 456)], 2000)
  expect(next.processes.find(row => row.pid === 10)).toEqual({ pid: 10, creationTime: 1, role: 'renderer', type: 'Tab', cpuPercent: 100, intervalMs: 1000, rssKib: 123 })
  expect(next.processes.find(row => row.pid === 20)).toMatchObject({ cpuPercent: 50, intervalMs: 1000, rssKib: 456 })
  expect(next.groups.find(row => row.role === 'renderer')).toEqual({ role: 'renderer', processCount: 2, rssKib: 579, cpuPercent: 150 })
  expect(next).toMatchObject({ rssKib: 579, logicalCpuCount: 14, omittedProcesses: 0 })
  const leases = Array.from({ length: 32 }, () => f.sampler.subscribe(() => {}))
  const before = f.nativeReads
  await f.sample([metric(10, 1.1), metric(20, .6)], 3000)
  expect(f.nativeReads).toBe(before + 1)
  expect(f.capacityReads).toBe(1)
  leases.forEach(off => off()); f.off()
  await vi.advanceTimersByTimeAsync(4000)
  expect(f.nativeReads).toBe(before + 1)
})

it('keeps process intervals separate from group peaks and expires group history by monotonic time', async () => {
  const f = harness([metric(10, 0)])
  await f.sample()
  await f.sample([metric(10, 1)], 2000)
  const low = await f.sample([metric(10, 1.1)], 3000)
  expect(low.processes[0]!.cpuPercent).toBeCloseTo(10)
  expect(low.cpuPercent).toBe(100)
  const expired = await f.sample([metric(10, 1.1)], 14001)
  expect(expired.cpuPercent).toBe(0)
  expect(expired.processes[0]!.intervalMs).toBe(11001)
})

it('preserves RSS while CPU is unknown for first, absent, reset, reused and invalid intervals', async () => {
  const f = harness([metric(10, 1)])
  await f.sample()
  for (const [row, at] of [[metric(10, undefined, 111), 2000], [metric(10, 2, 112), 3000],
    [metric(10, 1, 113), 4000], [metric(10, 3, 114, 2), 5000], [metric(10, 4, 115, 2), 5000]] as const) {
    const app = await f.sample([row], at)
    expect(app.processes[0]).toMatchObject({ cpuPercent: null, intervalMs: null, rssKib: row.memory.workingSetSize })
  }
  await f.sample([], 6000)
  const returned = await f.sample([metric(10, 5, 222, 2)], 7000)
  expect(returned.processes[0]).toMatchObject({ cpuPercent: null, rssKib: 222 })
  expect((f.sampler as any).appCpuCounters.size).toBe(1)
  f.off()
  expect((f.sampler as any).appCpuCounters.size).toBe(0)
})

it('bounds detail to256 CPU/RSS hotspots but includes every process in group and total facts', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => metric(i + 1, 0, 1))
  const f = harness(rows)
  await f.sample()
  for (let i = 0; i < rows.length; i++) rows[i] = metric(i + 1, .01, 1)
  rows[299] = metric(300, 2, 0); rows[298] = metric(299, 0, 1_000_000)
  const app = await f.sample(rows, 2000)
  expect(app.processes).toHaveLength(256)
  expect(new Set(app.processes.map(row => row.pid)).size).toBe(256)
  expect(app.processes.some(row => row.pid === 300)).toBe(true)
  expect(app.processes.some(row => row.pid === 299)).toBe(true)
  expect(app).toMatchObject({ processCount: 300, omittedProcesses: 44, rssKib: 1_000_298, cpuPercent: 498 })
  expect(app.groups.find(group => group.role === 'renderer')).toMatchObject({ processCount: 300, rssKib: 1_000_298, cpuPercent: 498 })
})

it('rejects oversized, invalid-type text and incoherent interval public shapes', () => {
  const snap = deepMetricsSnapshot().observation!
  snap.app = { state: 'available', observedAt: 1000, lastSuccessAt: 1000, reason: null, data: {
    processCount: 1, cpuPercent: 10, rssKib: 100, groups: [{ role: 'renderer', processCount: 1, cpuPercent: 10, rssKib: 100 }],
    processes: [{ pid: 1, creationTime: 1, role: 'renderer', type: 'Tab', cpuPercent: 10, intervalMs: 1000, rssKib: 100 }], omittedProcesses: 0, logicalCpuCount: 14, unavailable: null } }
  expect(parseMetricsObservation(snap).app.data!.processes[0]!.intervalMs).toBe(1000)
  snap.app.data!.processes[0]!.type = 'Future host worker'
  expect(parseMetricsObservation(snap).app.data!.processes[0]!.type).toBe('Future host worker')
  for (const mutation of [
    (value: typeof snap) => { value.app.data!.processes = Array.from({ length: 257 }, () => value.app.data!.processes[0]!) },
    (value: typeof snap) => { (value.app.data!.processes[0] as any).type = 'x'.repeat(129) },
    (value: typeof snap) => { value.app.data!.processes[0]!.intervalMs = null },
    (value: typeof snap) => { value.app.data!.logicalCpuCount = 0 },
    (value: typeof snap) => { value.app.data!.processes[0]!.pid = 0 },
    (value: typeof snap) => { value.app.data!.processes[0]!.type = '' },
    (value: typeof snap) => { value.app.data!.processes[0]!.type = 'host\nworker' },
    (value: typeof snap) => { value.renderer.data!.memory.heap = null },
    (value: typeof snap) => { (value.renderer.data!.memory as any).scope = 'all-process-RSS' }
  ]) {
    const bad = structuredClone(snap); mutation(bad)
    expect(() => parseMetricsObservation(bad)).toThrow()
  }
})

async function preload() {
  const oldHeap = Object.getOwnPropertyDescriptor(process, 'getHeapStatistics'), oldCreation = Object.getOwnPropertyDescriptor(process, 'getCreationTime')
  const heap = vi.fn(() => ({ usedHeapSize: 64, totalHeapSize: 128, totalPhysicalSize: 96, heapSizeLimit: 4096 }))
  const creation = vi.fn(() => 17)
  Object.defineProperty(process, 'getHeapStatistics', { configurable: true, value: heap })
  Object.defineProperty(process, 'getCreationTime', { configurable: true, value: creation })
  cleanup.push(() => {
    if (oldHeap) Object.defineProperty(process, 'getHeapStatistics', oldHeap); else delete (process as any).getHeapStatistics
    if (oldCreation) Object.defineProperty(process, 'getCreationTime', oldCreation); else delete (process as any).getCreationTime
  })
  await import('../src/preload/index')
  expect(native.api).toBeDefined()
  return { api: native.api!, heap, creation }
}

it('loads the actual preload API and returns fixed KiB fields; heap/creation failure remain independent', async () => {
  const f = await preload(), first = f.api.readRendererMemory()
  expect(first.process).toEqual({ pid: process.pid, creationTime: 17 })
  expect(first.memory).toMatchObject({ scope: 'renderer-v8-isolate', heap: { usedHeapKib: 64, totalHeapKib: 128, physicalHeapKib: 96, heapLimitKib: 4096 }, unavailable: null })
  expect(first.memory.sampledAt).toBeGreaterThan(0); expect(f.heap).toHaveBeenCalledOnce()
  f.creation.mockImplementation(() => { throw new Error('private OS error body') })
  expect(f.api.readRendererMemory()).toMatchObject({ process: { pid: process.pid, creationTime: null }, memory: { heap: { usedHeapKib: 64 } } })
  f.heap.mockImplementation(() => { throw new Error('private heap error body') })
  const failed = f.api.readRendererMemory()
  expect(failed).toMatchObject({ process: { pid: process.pid }, memory: { heap: null, unavailable: expect.any(String) } })
  expect(JSON.stringify(failed)).not.toContain('private')
})

async function actualRenderer() {
  const f = await preload()
  await import('../src/renderer/src/lib/api')
  const apiCode = typeof __AGENTMUX_RESOURCE_API_SOURCE__ === 'string' ? __AGENTMUX_RESOURCE_API_SOURCE__ : readFileSync(resolve('apps/desktop/src/renderer/src/lib/api.ts'), 'utf8')
  const apiFile = ts.createSourceFile('api.ts', apiCode, ts.ScriptTarget.Latest, true)
  const factories = apiFile.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'requireDesktopApi')
  expect(factories).toHaveLength(1)
  const factory = factories[0]!, factoryCode = ts.transpileModule(factory.getText(apiFile), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const api = new Function('window', 'createRendererControlApi', 'createRendererHistoryObservation', 'createRendererSessionEvents', 'unwrapSessionInputWriteResult', factoryCode + ';return requireDesktopApi()')(
    window, createRendererControlApi, createRendererHistoryObservation, createRendererSessionEvents, unwrapSessionInputWriteResult)
  if (process.env.AGENTMUX_TERMINAL_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_INPUT_LOADED + '.resources', JSON.stringify({
    path: resolve('apps/desktop/src/renderer/src/lib/api.ts'), sourceSHA256: createHash('sha256').update(apiCode).digest('hex'),
    callbackSHA256: createHash('sha256').update(factory.getText(apiFile)).digest('hex'), operation: 'desktop-api', invoked: true, threw: false }) + '\n')
  expect(api.readRendererMemory).toBe(native.api!.readRendererMemory)
  const { useAppStore, readRendererResourceOwnerCounts } = await import('../src/renderer/src/store')
  const { rendererPerformance } = await import('../src/renderer/src/lib/renderer-performance')
  expect(useAppStore.getState).toBeTypeOf('function')
  const code = typeof __AGENTMUX_RESOURCE_STORE_SOURCE__ === 'string' ? __AGENTMUX_RESOURCE_STORE_SOURCE__ : readFileSync(resolve('apps/desktop/src/renderer/src/store.ts'), 'utf8')
  const source = ts.createSourceFile('store.ts', code, ts.ScriptTarget.Latest, true)
  const callbacks: ts.ArrowFunction[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'api.control.onRequest' && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) callbacks.push(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(source); expect(callbacks).toHaveLength(1)
  const callback = callbacks[0]!, transpiled = ts.transpileModule('const invoke = ' + callback.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const invoke = new Function('api', 'get', 'readContinuousProgressInput', 'readRendererResourceOwnerCounts', 'rendererPerformance', transpiled + ';return invoke')(
    api, useAppStore.getState, () => { throw new Error('wrong branch') }, readRendererResourceOwnerCounts, rendererPerformance)
  rendererPerformance.sessionEvent('status', rendererPerformance.start())
  const execute = (request: any) => {
    let threw = true
    try { const result = invoke(request, new AbortController().signal); expect(result).toHaveProperty('memory'); threw = false; return result }
    finally {
      if (process.env.AGENTMUX_TERMINAL_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_INPUT_LOADED + '.resources', JSON.stringify({
        path: resolve('apps/desktop/src/renderer/src/store.ts'), sourceSHA256: createHash('sha256').update(code).digest('hex'),
        callbackSHA256: createHash('sha256').update(callback.getText(source)).digest('hex'), operation: request.operation, invoked: true, threw }) + '\n')
    }
  }
  return { ...f, execute }
}

it('executes the real Store memory caller through Main bridge and preserves counts/timings on heap failure', async () => {
  const f = await actualRenderer(), window = { windowId: 1, webContentsId: 2, generation: 3 }
  f.heap.mockImplementation(() => { throw new Error('heap unavailable') })
  let bridge: DesktopControlIpcBridge
  bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendCancellation() {}, sendRequest(request) {
    bridge.accept({ requestId: request.requestId, ok: true, result: f.execute(request) })
  } })
  cleanup.push(() => bridge.dispose())
  const result = await observeRendererResources(bridge, () => window, new AbortController().signal, () => process.pid)
  expect(result.data).toMatchObject({ process: { pid: process.pid, creationTime: 17 }, memory: { heap: null, unavailable: expect.any(String) } })
  expect(result.data.counts.runtimeSubscriptions).toBeGreaterThanOrEqual(0)
  expect(result.data.performance.sessionEvents.count).toBeGreaterThan(0)
})

it('rejects a stale OS process instance even when the old window-generation reply is otherwise valid', async () => {
  const window = { windowId: 1, webContentsId: 2, generation: 3 }
  let request: any, pid = 10
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendCancellation() {}, sendRequest(value) { request = value } })
  cleanup.push(() => bridge.dispose())
  for (const mode of ['owner-process-changed', 'reply-process-wrong', 'generation-changed']) {
    pid = 10
    let generation = window.generation
    const reading = observeRendererResources(bridge, () => ({ ...window, generation }), new AbortController().signal, () => pid)
    if (mode === 'owner-process-changed') pid = 20
    if (mode === 'generation-changed') generation++
    bridge.accept({ requestId: request.requestId, ok: true, result: { operation: 'metrics.renderer', window,
      observedAt: 1000, ...rendererMemoryFixture(mode === 'reply-process-wrong' ? 20 : 10), counts: deepMetricsSnapshot().observation!.renderer.data!.counts,
      performance: deepMetricsSnapshot().observation!.renderer.data!.performance } })
    const outcome = await reading.then(value => ({ value }), error => ({ error }))
    expect(outcome).toMatchObject({ error: { code: 'CONTROL_OWNER_LOST' } })
  }
})

it('delivers actual sampler and preload/Store memory through Unix get/watch, compiled CLI get/watch and Toolkit', async () => {
  const renderer = await actualRenderer(), f = harness([metric(process.pid, 0, 1800, 17)])
  await f.sample(); await f.sample([metric(process.pid, .12, 1800, 17)], 2000)
  const window = { windowId: 1, webContentsId: 2, generation: 3 }
  let bridge: DesktopControlIpcBridge
  bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendCancellation() {}, sendRequest(request) {
    bridge.accept({ requestId: request.requestId, ok: true, result: renderer.execute(request) })
  } })
  cleanup.push(() => bridge.dispose())
  f.sampler.setObservationSources({ observeRuntime: async () => [], processOwners: () => ({ rendererPids: [process.pid], browserPids: [] }),
    mainOwners: () => ({ sessionAttachmentOwners: 0, sessionAttachmentLeases: 0, fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }),
    observeRenderer: signal => observeRendererResources(bridge, () => window, signal, () => process.pid) })
  await f.sample([metric(process.pid, .24, 1800, 17)], 3000)
  const port = createResourceMetricsPort({ sampler: f.sampler, currentWindow: () => window })
  cleanup.push(() => port.dispose())
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-attribution-')), path = join(directory, 'control.sock')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ execute: vi.fn(), coreClients: () => [], metrics: port }, path)
  await server.start(); cleanup.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  cleanup.push(() => client.dispose())
  const result = await client.call('system.metrics.get', {}), observation = parseMetricsObservation(result.observation)
  expect(observation.app.data!.processes[0]).toMatchObject({ pid: process.pid, creationTime: 17, cpuPercent: 12, intervalMs: 1000, rssKib: 1800 })
  expect(observation.renderer.data).toMatchObject({ process: { pid: process.pid, creationTime: 17 }, memory: { heap: { usedHeapKib: 64 } } })
  const sub = await client.subscribe('system.metrics.watch', {}, { onInitial(value) { expect(value.observation.app.data!.processes).toEqual(observation.app.data!.processes) }, onEvent() {} })
  await sub.dispose()
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + path, 'system', 'metrics', 'get'], objectCliEnvironment(directory))
  expect(cli.code).toBe(0); expect(cli.stderr).toBe('')
  expect(JSON.parse(cli.stdout).result.observation.renderer.data.memory).toEqual(observation.renderer.data!.memory)
  const child = spawn(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', 'unix://' + path, 'system', 'metrics', 'watch'], { env: objectCliEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(done => child.once('close', () => done())) } })
  let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes })
  const initial = await new Promise<any>((done, reject) => {
    let text = ''
    child.stdout!.on('data', bytes => { text += bytes; if (text.includes('\n')) { try { done(JSON.parse(text.split('\n')[0]!)) } catch (error) { reject(error) } } })
    child.once('error', reject); child.once('close', code => reject(new Error('watch ended before frame:' + code + ':' + stderr)))
  })
  child.kill('SIGTERM'); await new Promise<void>(done => child.once('close', () => done()))
  expect(initial.result.initial.observation.app.data.processes).toEqual(observation.app.data!.processes)
  const toolkit = deepMetricsSnapshot(); toolkit.observation = observation; toolkit.observedAt = observation.observedAt
  expect(parseToolkitSnapshot(toolkit).observation!.renderer.data!.process).toEqual(observation.renderer.data!.process)
})
