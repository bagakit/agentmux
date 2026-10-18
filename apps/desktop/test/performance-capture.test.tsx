// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { RENDERER_TRACE_CATEGORIES, type MetricsObservation, type RendererV8Profile, type RendererV8ProfileInput, type RendererV8ProfileResult, type RendererTraceResult } from '@agentmux/core/control'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld(_key: string, value: AgentMuxPreloadApi) { bridge.api = value } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() }, webFrame: {} }))
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
import '../src/preload/index'
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { PerformanceOverview } from '../src/renderer/src/components/performance/PerformanceOverview'
import { currentPerformanceCaptureTarget } from '../src/renderer/src/components/performance/PerformanceCapture'
import { analyseV8Profile, parseV8ProfileBytes, summariseV8Profile } from '../../../packages/core/src/v8-profile-analysis'
import { profileFlameRows } from '../src/renderer/src/lib/renderer-profile-analysis'
import { registerPerformanceCaptureIpc } from '../src/main/performance-capture-ipc'
import { ProcessResourceSampler, type ResourceSample } from '../src/main/process-resource-sampler'
import { RendererV8Profiler } from '../src/main/renderer-v8-profile'
import { usePerformanceScene } from '../src/renderer/src/lib/use-performance-scene'
import { performanceAttributionSnapshots as samples } from '../scripts/fixtures/performance-panel/data'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const originalProfile = (): RendererV8Profile => ({ startTime: 10, endTime: 5010, samples: [2, 3, 2], timeDeltas: [1000, 2500, 1500],
  nodes: [
    { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: 'renderWorkspace', scriptId: '1', url: 'app://renderer/workspace.js', lineNumber: 1, columnNumber: 0 }, children: [3] },
    { id: 3, callFrame: { functionName: 'veryLongFunctionNameForADeeplyNestedModule', scriptId: '2', url: 'app://renderer/long-module.js', lineNumber: 4, columnNumber: 0 } }
  ] })
function capture(input: RendererV8ProfileInput): RendererV8ProfileResult {
  const profile = originalProfile(), json = JSON.stringify(profile)
  return { ...input, schema: 'agentmux.renderer-v8-profile.v1', scope: 'renderer-main-thread-v8', status: 'completed',
    timing: { requestedAt: _historyFixtureEpoch(0, 0, 1), startedAt: _historyFixtureEpoch(0, 0, 2), stoppedAt: _historyFixtureEpoch(0, 0, 3), finishedAt: _historyFixtureEpoch(0, 0, 4), startMonotonicMs: 1, stopMonotonicMs: 3 }, profilerTimeUnit: 'microseconds',
    sourceVerified: { before: true, after: true }, cleanup: { stopRequested: true, stopAcknowledged: true, disableAcknowledged: true, detached: 'confirmed' },
    profile, profileBytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex'), issues: [] }
}
function unknownTrace(input: RendererV8ProfileInput): RendererTraceResult { return { ...input, schema: 'agentmux.renderer-trace.v2', scope: 'chromium-target-related-timeline', status: 'unknown',
    transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'gzip', traceTimeUnit: 'microseconds', requestedCategories: [...RENDERER_TRACE_CATEGORIES],
    timing: { requestedAt: _historyFixtureEpoch(0, 0, 1), startedAt: _historyFixtureEpoch(0, 0, 2), endAcknowledgedAt: null, completedAt: null, finishedAt: _historyFixtureEpoch(0, 0, 3), startMonotonicMs: 1, endMonotonicMs: null, completeMonotonicMs: null },
    sourceVerified: { before: true, after: false }, lifecycle: { startRequested: true, startAcknowledged: true, endRequested: true, endAcknowledged: false, tracingComplete: false, dataLossOccurred: null, detached: 'unconfirmed' },
    stream: { handleReceived: false, eof: false, closeRequested: false, closeAcknowledged: false },
    bufferUsage: { observations: 0, maxFraction: null, fullObserved: false }, receivedEvents: 0, receivedTraceBytes: 0, receivedGzipBytes: 0, trace: null, traceBytes: null, sha256: null, issues: [] } }

function completedTrace(input: RendererV8ProfileInput): RendererTraceResult {
  const raw = '{ "metadata": {"original":"λ"}, "traceEvents":[{"pid":4,"name":"Layout","args":{"future":[1,true,null]}}], "futureRoot": true }'
  const gzip = gzipSync(raw), hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const original = unknownTrace(input)
  return { ...original, status: 'completed', sourceVerified: { before: true, after: true },
    timing: { ...original.timing, endAcknowledgedAt: original.timing.finishedAt, completedAt: original.timing.finishedAt, endMonotonicMs: 2001, completeMonotonicMs: 2002 },
    lifecycle: { ...original.lifecycle, endAcknowledged: true, tracingComplete: true, dataLossOccurred: false, detached: 'confirmed' },
    stream: { handleReceived: true, eof: true, closeRequested: true, closeAcknowledged: true },
    receivedEvents: 1, receivedTraceBytes: Buffer.byteLength(raw), receivedGzipBytes: gzip.length,
    trace: { encoding: 'base64', data: gzip.toString('base64'), bytes: gzip.length, sha256: hash(gzip) }, traceBytes: Buffer.byteLength(raw), sha256: hash(raw) }
}

let root: Root, container: HTMLDivElement, initial: ReturnType<typeof useAppStore.getState>
let profilePort: ReturnType<typeof vi.fn>, tracePort: ReturnType<typeof vi.fn>, animationsPort: ReturnType<typeof vi.fn>, scenePort: ReturnType<typeof vi.fn>
const handlers = new Map<string, (event: never, input: unknown) => unknown>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); initial = useAppStore.getState()
  profilePort = vi.fn(async (input: RendererV8ProfileInput) => capture(input)); tracePort = vi.fn(); animationsPort = vi.fn()
  scenePort = vi.fn(async () => { throw new Error('Controlled scene refusal from Main') })
  handlers.clear(); registerPerformanceCaptureIpc({ captureProfile: profilePort, captureTrace: tracePort, inspectAnimations: animationsPort,
    captureScene: scenePort, inspectScene: async () => ({ status: 'absent', scene: null, issue: null }), subscribe: vi.fn() }, (channel, handler) => handlers.set(channel, handler))
  bridge.invoke.mockImplementation((channel, input) => handlers.get(channel)!(undefined as never, input))
  vi.spyOn(api.performance, 'captureProfile').mockImplementation(input => bridge.api!.performance.captureProfile(input))
  vi.spyOn(api.performance, 'captureTrace').mockImplementation(input => bridge.api!.performance.captureTrace(input))
  vi.spyOn(api.performance, 'inspectAnimations').mockImplementation(input => bridge.api!.performance.inspectAnimations(input))
  vi.spyOn(api.performance, 'captureScene').mockImplementation(input => bridge.api!.performance.captureScene(input))
  vi.spyOn(api.performance, 'inspectScene').mockImplementation(input => bridge.api!.performance.inspectScene(input))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); bridge.invoke.mockReset() })
function node<T extends HTMLElement = HTMLElement>(selector: string): T { const n = document.querySelector<T>(selector); expect(n).not.toBeNull(); expect(n!.isConnected).toBe(true); return n! }
const click = async (selector: string) => act(async () => node<HTMLButtonElement>(selector).click())
const render = async (snapshot = samples.fresh) => act(async () => root.render(<PerformanceOverview snapshot={snapshot} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />))
const sampleButton = '[data-performance-capture] [data-performance-action="profile"]'

function OverviewWithScene({ snapshot }: { snapshot: typeof samples.fresh }) {
  const scene = usePerformanceScene(true)
  return <PerformanceOverview snapshot={snapshot} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} scene={scene} />
}
async function omittedRendererSnapshot() {
  const snapshot = structuredClone(samples.fresh), observation = snapshot.observation!, renderer = observation.renderer.data!
  const metrics = Array.from({ length: 257 }, (_, index) => ({ pid: renderer.process.pid! + index,
    creationTime: renderer.process.creationTime!, type: 'Tab', cpu: { cumulativeCPUUsage: 0 },
    memory: { workingSetSize: index === 0 ? 1 : 1000 + index } })) as Electron.ProcessMetric[]
  const sampler = new ProcessResourceSampler(async () => '', () => observation.observedAt, () => metrics, () => 1000, () => 8)
  sampler.setObservationSources({ observeRuntime: async () => [], mainOwners: () => ({ sessionAttachmentOwners: 0,
    sessionAttachmentLeases: 0, fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }),
    processOwners: () => ({ rendererPids: [renderer.process.pid!], browserPids: metrics.slice(1).map(process => process.pid) }) })
  try {
    const sample = await new Promise<ResourceSample>(resolve => sampler.subscribe(value => { if (value.app) resolve(value) }))
    observation.app.data = sample.app
    expect(sample.app).toMatchObject({ processCount: 257, omittedProcesses: 1, unavailable: null })
    expect(sample.app!.processes).toHaveLength(256)
    expect(sample.app!.processes.map(process => process.pid)).not.toContain(renderer.process.pid)
    return snapshot
  } finally { sampler.dispose() }
}

it('actual App popover sends its exact target through product preload and registered metrics delegate, then drills real weighted samples', async () => {
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, callback) => { callback(samples.fresh); return { dispose() {} } })
  useAppStore.setState({ ...initial, config: { ...composerConfig, toolkit: { performance: { enabled: true, statusBar: 'label' } } }, loading: false,
    initialize: async () => () => {}, detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}), sessions: [composerSession('capture-session')],
    providerCatalog: await api.providers.list(), mainSurface: 'workbench', toolsOpen: false, tabs: {}, layouts: {} }, true)
  await act(async () => root.render(<App />)); await click('.performance-trigger')
  expect(profilePort).not.toHaveBeenCalled(); await click('[data-performance-capture] > summary'); await click(sampleButton)
  const expected = { target: currentPerformanceCaptureTarget(samples.fresh.observation), durationMs: 2000 }
  expect(bridge.invoke).toHaveBeenCalledWith('metrics:captureProfile', expected); expect(profilePort).toHaveBeenCalledExactlyOnceWith(expected)
  expect(node('[aria-label="Module sample heatmap"]').textContent).toContain('2.5 ms')
  expect(node('[aria-label="Sampled call stacks"]').textContent).toContain('renderWorkspace')
  await click('.performance-module-row')
  expect(node('.performance-frame-detail').textContent).toContain('app://renderer/')
  await click('.performance-capture-result .performance-inline-action'); expect(node('.performance-frame-detail').textContent).toContain('(root)')
  expect(node('[aria-label="Capture result"]').textContent).toContain('completed')
})

it('an unknown animation read retains the completed profile and its selected flame frame', async () => {
  animationsPort.mockImplementation(async ({ target }) => ({ target, schema: 'agentmux.renderer-animations.v1', scope: 'renderer-document', status: 'unknown',
    timing: { requestedAt: _historyFixtureEpoch(0, 0, 1), sampledAt: null, finishedAt: _historyFixtureEpoch(0, 0, 2) },
    sourceVerified: { before: true, after: false }, evaluation: { requested: true, settled: false }, snapshot: null,
    issues: [{ stage: 'evaluate', code: 'CONTROL_TIMEOUT', message: 'Fixture evaluation completion unknown', messageTruncated: false }] }))
  await render(); await click(sampleButton); await click('.performance-module-row')
  const originalFrame = node('.performance-frame-detail')
  await click('[data-performance-action="animations"]')
  expect(node('[aria-label="Animation inspection result"]').textContent).toContain('unknown')
  expect(node('.performance-frame-detail')).toBe(originalFrame); expect(originalFrame.isConnected).toBe(true)
  expect(profilePort).toHaveBeenCalledOnce(); expect(animationsPort).toHaveBeenCalledOnce(); expect(tracePort).not.toHaveBeenCalled()
})

it('mounted capture and scene consumers submit the exact Renderer even when the real sampler omits it from 256 hotspots', async () => {
  const omitted = await omittedRendererSnapshot(), unavailable = structuredClone(omitted)
  unavailable.observation!.app = { state: 'unavailable', data: null, observedAt: null, lastSuccessAt: null, reason: 'Controlled app observation failure' }
  const observation = omitted.observation!, renderer = observation.renderer.data!
  const target = { ...observation.window!, pid: renderer.process.pid!, creationTime: renderer.process.creationTime! }
  tracePort.mockImplementation(async input => unknownTrace(input))
  animationsPort.mockImplementation(async ({ target }) => ({ target, schema: 'agentmux.renderer-animations.v1', scope: 'renderer-document', status: 'unknown',
    timing: { requestedAt: _historyFixtureEpoch(0, 0, 1), sampledAt: null, finishedAt: _historyFixtureEpoch(0, 0, 2) },
    sourceVerified: { before: true, after: false }, evaluation: { requested: true, settled: false }, snapshot: null, issues: [] }))
  for (const snapshot of [omitted, unavailable]) {
    await act(async () => root.render(<OverviewWithScene snapshot={snapshot} />))
    const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-performance-action], [data-performance-scene-capture]')]
    expect(actions.map(action => action.disabled)).toEqual([false, false, false, false])
    expect(profilePort).toHaveBeenCalledTimes(snapshot === omitted ? 0 : 1)
    await click(sampleButton)
    await click('[data-performance-action="trace"]')
    await click('[data-performance-action="animations"]')
    await click('[data-performance-scene-capture]')
    expect(profilePort).toHaveBeenLastCalledWith({ target, durationMs: 2000 })
    expect(tracePort).toHaveBeenLastCalledWith({ target, durationMs: 2000 })
    expect(animationsPort).toHaveBeenLastCalledWith({ target })
    expect(scenePort).toHaveBeenLastCalledWith({ target })
    expect(bridge.invoke).toHaveBeenCalledWith('metrics:captureScene', { target })
    expect(node('[aria-label="Performance scene"]').textContent).toContain('Controlled scene refusal from Main')
    expect(node('.performance-metrics')).toBeDefined()
  }
  expect(profilePort).toHaveBeenCalledTimes(2); expect(tracePort).toHaveBeenCalledTimes(2)
  expect(animationsPort).toHaveBeenCalledTimes(2); expect(scenePort).toHaveBeenCalledTimes(2)
  if (process.env.AGENTMUX_CAPTURE_TARGET_SAMPLES) appendFileSync(process.env.AGENTMUX_CAPTURE_TARGET_SAMPLES, JSON.stringify({
    phase: 'omitted-renderer-mounted-actions', target, sampler: { processCount: observation.app.data!.processCount,
      returnedProcesses: observation.app.data!.processes.length, omittedProcesses: observation.app.data!.omittedProcesses },
    profile: profilePort.mock.calls, trace: tracePort.mock.calls, animations: animationsPort.mock.calls, scene: scenePort.mock.calls
  }) + '\n')
})

it('missing, stale or mismatched Renderer source keeps all mounted capture actions unavailable without sampling', async () => {
  const changes: ((value: MetricsObservation) => void)[] = [
    value => { value.renderer.state = 'stale' }, value => { value.renderer.state = 'unavailable' },
    value => { value.renderer.data = null }, value => { value.window = null },
    value => { value.renderer.data!.process.pid = null }, value => { value.renderer.data!.process.creationTime = null },
    value => { value.renderer.data!.window.windowId++ }, value => { value.renderer.data!.window.webContentsId++ },
    value => { value.renderer.data!.window.generation++ }
  ]
  for (const change of changes) {
    const snapshot = structuredClone(samples.fresh); change(snapshot.observation!)
    await act(async () => root.render(<OverviewWithScene snapshot={snapshot} />))
    const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-performance-action], [data-performance-scene-capture]')]
    expect(actions.map(action => action.disabled)).toEqual([true, true, true, true])
    for (const action of actions) await act(async () => action.click())
  }
  expect(profilePort).not.toHaveBeenCalled(); expect(tracePort).not.toHaveBeenCalled()
  expect(animationsPort).not.toHaveBeenCalled(); expect(scenePort).not.toHaveBeenCalled()
})

it('a reused PID reaches the original Main exact-target fence and is refused before native capture', async () => {
  const observation = samples.newInstance.observation!, previous = observation.renderer.data!.process
  const currentProcess = observation.app.data!.processes.find(process => process.pid === previous.pid)!
  const target = { ...observation.window!, pid: previous.pid!, creationTime: previous.creationTime! }
  const attach = vi.fn(() => { throw new Error('Wrong target reached native debugger') })
  const contents = { debugger: { attach, isAttached: () => false }, isDevToolsOpened: () => false,
    removeListener: vi.fn(), isDestroyed: () => false } as unknown as WebContents
  const profiler = new RendererV8Profiler(contents, () => ({ ...target, creationTime: currentProcess.creationTime }))
  profilePort.mockImplementation(input => profiler.capture(input))
  try {
    await render(samples.newInstance)
    expect(node<HTMLButtonElement>(sampleButton).disabled).toBe(false)
    await click(sampleButton)
    expect(profilePort).toHaveBeenCalledExactlyOnceWith({ target, durationMs: 2000 })
    expect(node('[data-performance-capture]').textContent).toContain('The exact Renderer profile target is no longer current')
    expect(attach).not.toHaveBeenCalled()
    expect(node('.performance-metrics')).toBeDefined()
  } finally { profiler.dispose() }
})

it('an in-flight explicit click is single-use, and a late original result retains its original target after readings change', async () => {
  let complete!: (value: RendererV8ProfileResult) => void
  profilePort.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await render(); await click(sampleButton); await click(sampleButton)
  expect(profilePort).toHaveBeenCalledOnce(); expect(node<HTMLButtonElement>(sampleButton).disabled).toBe(true)
  const changed = structuredClone(samples.fresh)
  changed.observation!.window!.generation++; changed.observation!.renderer.data!.window.generation++
  await render(changed)
  await act(async () => complete(capture(profilePort.mock.calls[0]![0])))
  expect(node('[data-performance-capture]').textContent).toContain('Showing the original captured process')
  expect(node('[aria-label="Capture result"]').textContent).toContain('PID 2345')
  expect(profilePort).toHaveBeenCalledOnce()
})

it('unknown and empty captures retain the receipt and do not invent attribution or automatically resample', async () => {
  profilePort.mockImplementation(async input => ({ ...capture(input), status: 'unknown', profile: null, profileBytes: null, sha256: null,
    sourceVerified: { before: true, after: false }, cleanup: { stopRequested: true, stopAcknowledged: false, disableAcknowledged: false, detached: 'unconfirmed' } }))
  await render(); await click(sampleButton)
  expect(node('[aria-label="Capture result"]').textContent).toContain('unconfirmed')
  expect(document.querySelector('[aria-label="Sampled call stacks"]')).toBeNull()
  await render(samples.refresh); expect(profilePort).toHaveBeenCalledOnce()
  profilePort.mockImplementation(async input => { const result = capture(input); delete result.profile!.samples; delete result.profile!.timeDeltas; const json = JSON.stringify(result.profile); return { ...result, profileBytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex') } })
  await click(sampleButton)
  expect(node('[aria-label="Capture result"]').textContent).toContain('No weighted V8 samples')
  expect(node('.performance-capture-receipt').textContent).toContain('"detached": "confirmed"')
})

it('a refused capture keeps ordinary readings and the last original material; malformed delegate target is rejected', async () => {
  await render(); await click(sampleButton); profilePort.mockRejectedValueOnce(new Error('Original debugger is owned'))
  await click(sampleButton)
  expect(node('[data-performance-capture]').textContent).toContain('Original debugger is owned')
  expect(node('[aria-label="V8 sample interpretation"]').textContent).toContain('Original profile 5.0 ms')
  expect(node('[aria-label="V8 sample interpretation"]').textContent).toContain('weighted samples 5.0 ms')
  expect(node('[aria-label="V8 sample interpretation"]').textContent).toContain('not process CPU')
  expect(node('[aria-label="Module sample heatmap"]').textContent).toContain('workspace.js')
  expect(node('.performance-metrics').textContent).toContain('1.48 cores')
  const input = { target: currentPerformanceCaptureTarget(samples.fresh.observation)!, durationMs: 2000 }
  profilePort.mockImplementationOnce(async value => ({ ...capture(value), target: { ...value.target, generation: value.target.generation + 1 } }))
  await expect(bridge.api!.performance.captureProfile(input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  await expect(bridge.api!.performance.captureProfile({ ...input, durationMs: 0 })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
})

it('the timeline GUI consumes the same exact-source Main delegate and original unknown lifecycle instead of inventing rendering analysis', async () => {
  tracePort.mockImplementation(async input => unknownTrace(input))
  await render(); await click('[data-performance-capture] [data-performance-action="trace"]')
  expect(bridge.invoke).toHaveBeenCalledWith('metrics:captureTrace', { target: currentPerformanceCaptureTarget(samples.fresh.observation), durationMs: 2000 })
  expect(tracePort).toHaveBeenCalledOnce(); expect(profilePort).not.toHaveBeenCalled()
  expect(node('[aria-label="Capture result"]').textContent).toContain('unconfirmed')
  expect(node('.performance-capture-receipt').textContent).toContain('"endAcknowledged": false')
  expect(document.querySelector('[aria-label="Sampled call stacks"]')).toBeNull()
})

it('export preserves original profile and omits profile payload from its receipt without another capture', async () => {
  const create = vi.fn((_blob: Blob) => 'blob:private-capture'), revoke = vi.fn(), downloads: { name: string; blob: Blob }[] = []
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push({ name: this.download, blob: create.mock.calls.at(-1)![0] as Blob }) })
  await render(); await click(sampleButton); await click('.performance-capture-result .performance-capture-actions > button:first-child'); await click('.performance-capture-result .performance-capture-actions > button:last-child')
  expect(downloads.map(item => item.name)).toEqual(['renderer.cpuprofile', 'renderer-capture-receipt.json'])
  expect(JSON.parse(await downloads[0]!.blob.text())).toEqual(originalProfile())
  expect(JSON.parse(await downloads[1]!.blob.text())).toEqual({ ...capture(profilePort.mock.calls[0]![0]), profile: '(export original profile)' })
  expect(profilePort).toHaveBeenCalledOnce()
})


it('empty source URLs stay explicit while actual script names use their basename', async () => {
  profilePort.mockImplementation(async input => { const result = capture(input); result.profile!.nodes[1]!.callFrame.url = ''; const json = JSON.stringify(result.profile); return { ...result, profileBytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex') } })
  await render(); await click(sampleButton)
  expect(node('.performance-module-row').textContent).toContain('(no source URL)')
  expect(node('[aria-label="Module sample heatmap"]').textContent).toContain('long-module.js')
})

it('an unknown trace retains the completed profile and selected frame, with independent original targets and exports', async () => {
  const create = vi.fn((_blob: Blob) => 'blob:private-capture'), downloads: { name: string; blob: Blob }[] = []
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push({ name: this.download, blob: create.mock.calls.at(-1)![0] as Blob }) })
  await render(); await click(sampleButton); await click('.performance-module-row')
  const originalFrame = node('.performance-frame-detail'), profileResult = capture(profilePort.mock.calls[0]![0])
  const changed = structuredClone(samples.fresh), observation = changed.observation!, renderer = observation.renderer.data!
  const previous = renderer.process
  const replacement = { pid: previous.pid! + 1, creationTime: previous.creationTime! + 1 }
  renderer.process = replacement
  observation.window!.generation++; renderer.window.generation++
  observation.app.data!.processes = observation.app.data!.processes.map(process => process.pid === previous.pid && process.creationTime === previous.creationTime ? { ...process, ...replacement } : process)
  await render(changed)
  tracePort.mockImplementation(async input => unknownTrace(input))
  await click('[data-performance-capture] [data-performance-action="trace"]')
  const latest = node('[aria-label="Capture result"]'), retained = node('[aria-label="Retained completed JavaScript profile"]')
  expect(latest.textContent).toContain('unknown'); expect(latest.textContent).toContain('PID 2346')
  expect(latest.querySelector('[aria-label="Sampled call stacks"]')).toBeNull()
  expect(retained.textContent).toContain('completed'); expect(retained.textContent).toContain('PID 2345')
  expect(retained.textContent).toContain('Showing the original captured process')
  expect(latest.textContent).not.toContain('Showing the original captured process')
  expect(retained.querySelector('.performance-frame-detail')).toBe(originalFrame); expect(originalFrame.isConnected).toBe(true)
  await click('[aria-label="Capture result"] .performance-capture-actions > button:last-child')
  await click('[aria-label="Retained completed JavaScript profile"] .performance-capture-actions > button:first-child')
  await click('[aria-label="Retained completed JavaScript profile"] .performance-capture-actions > button:last-child')
  expect(downloads.map(item => item.name)).toEqual(['renderer-capture-receipt.json', 'renderer.cpuprofile', 'renderer-capture-receipt.json'])
  expect(JSON.parse(await downloads[0]!.blob.text())).toEqual(unknownTrace(tracePort.mock.calls[0]![0]))
  expect(JSON.parse(await downloads[1]!.blob.text())).toEqual(originalProfile())
  expect(JSON.parse(await downloads[2]!.blob.text())).toEqual({ ...profileResult, profile: '(export original profile)' })
  expect(profilePort).toHaveBeenCalledOnce(); expect(tracePort).toHaveBeenCalledOnce()
})

it.each(['unknown', 'failed'] as const)('a %s V8 result keeps the last completed profile without duplicating a new successful result', async status => {
  await render(); await click(sampleButton)
  profilePort.mockImplementationOnce(async input => ({ ...capture(input), status, profile: null, profileBytes: null, sha256: null,
    sourceVerified: { before: true, after: false }, cleanup: { stopRequested: true, stopAcknowledged: false, disableAcknowledged: false, detached: 'unconfirmed' } }))
  await click(sampleButton)
  expect(node('[aria-label="Capture result"]').textContent).toContain(status)
  expect(node('[aria-label="Retained completed JavaScript profile"]').textContent).toContain('workspace.js')
  await click(sampleButton)
  expect(document.querySelector('[aria-label="Retained completed JavaScript profile"]')).toBeNull()
  expect(document.querySelectorAll('.performance-capture-result')).toHaveLength(1)
  expect(node('[aria-label="Module sample heatmap"]').textContent).toContain('workspace.js')
})

it('self time and inclusive tree weights stay separate; malformed trees and empty weights stay unanalysable', () => {
  const analysis = analyseV8Profile(originalProfile()); expect(analysis.reason).toBeNull(); if (!analysis.data) throw Error('nonempty analysis required')
  expect(analysis.data.profileDurationMs).toBe(5); expect(analysis.data.lastSampleTailMs).toBe(0);
  expect(analysis.data.sampledMs).toBe(5); expect(analysis.data.frames.get(2)).toMatchObject({ selfMs: 2.5, totalMs: 5 })
  expect(analysis.data.modules.map(module => module.selfMs)).toEqual([2.5, 2.5])
  expect(profileFlameRows(analysis.data, 1).rows).toEqual(expect.arrayContaining([{ id: 3, depth: 2, left: 0, width: 50 }]))
  const cyclic = originalProfile(); cyclic.nodes[2]!.children = [1]
  expect(analyseV8Profile(cyclic).data).toBeNull()
  expect(analyseV8Profile({ ...originalProfile(), timeDeltas: [0, 0, 0] }).reason).toContain('zero')
})

it('keeps an anonymous script distinct from a literal runtime display label when selecting a module', async () => {
  profilePort.mockImplementationOnce(async input => {
    const result = capture(input), profile = result.profile!
    profile.nodes[1]!.callFrame.url = ''
    profile.nodes[2]!.callFrame.url = '(runtime / no script)'
    const json = JSON.stringify(profile)
    return { ...result, profile, profileBytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex') }
  })
  await render(); await click(sampleButton)
  expect(document.querySelectorAll('.performance-module-row')).toHaveLength(2)
  await click('.performance-module-row')
  expect(node('.performance-frame-detail').textContent).toContain('renderWorkspace')
  expect(node('.performance-frame-detail').textContent).toContain('(no source URL)')
  expect(node('.performance-frame-detail').textContent).not.toContain('(runtime / no script)')
})

const localProfileFile = (name = 'saved.cpuprofile', profile = originalProfile()) => new File(['\n', JSON.stringify(profile, null, 2), '\n'], name, { type: 'application/json' })
async function chooseLocalProfile(file: File | null) {
  await act(async () => {
    const input = node<HTMLInputElement>('[aria-label="Choose saved CPU profile"]')
    Object.defineProperty(input, 'files', { configurable: true, value: file ? [file] : [] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function waitForLocalProfile(name: string) {
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(node('[aria-label="Imported CPU profile"]').textContent).toContain(name)
  })
}

it('imports through the real Tool and exports exact original bytes and the shared CLI technical report without capture', async () => {
  const downloads: { name: string; blob: Blob }[] = [], create = vi.fn((_blob: Blob) => 'blob:original-local-file')
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: create.mock.calls.at(-1)![0] as Blob })
  })
  await render()
  const file = localProfileFile()
  await chooseLocalProfile(file); await waitForLocalProfile(file.name)
  const result = node('[aria-label="Imported CPU profile"]')
  expect(result.textContent).toContain('process and build unverified')
  expect(result.querySelector('.performance-capture-result')).toBeNull()
  await click('[aria-label="Imported CPU profile"] .performance-capture-actions > button:first-child')
  await click('[aria-label="Imported CPU profile"] .performance-capture-actions > button:last-child')
  expect(downloads.map(item => item.name)).toEqual([file.name, 'profile-analysis.json'])
  const raw = Buffer.from(await file.arrayBuffer())
  expect(Buffer.from(await downloads[0]!.blob.arrayBuffer())).toEqual(raw)
  const source = { sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length, captureIdentity: 'unavailable-in-bare-profile' as const }
  const report = JSON.parse(await downloads[1]!.blob.text())
  expect(report).toEqual(summariseV8Profile(analyseV8Profile(parseV8ProfileBytes(raw)), source))
  expect(report.source).toEqual(source)
  expect(report.timing.weightedMs).toBe(5)
  expect(profilePort).not.toHaveBeenCalled(); expect(tracePort).not.toHaveBeenCalled(); expect(scenePort).not.toHaveBeenCalled()
})

it('keeps local analysis available without an observation or target while the Tool is paused and a capture is busy', async () => {
  await act(async () => root.render(<PerformanceOverview snapshot={null} paused singleCaptureBusy close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />))
  expect(node<HTMLButtonElement>('[data-performance-profile-import] .performance-capture-actions > button').disabled).toBe(false)
  await chooseLocalProfile(localProfileFile()); await waitForLocalProfile('saved.cpuprofile')
  expect(profilePort).not.toHaveBeenCalled(); expect(tracePort).not.toHaveBeenCalled()
  await click('[data-performance-profile-import] > .performance-capture-actions > button:last-child')
  expect(document.querySelector('[aria-label="Imported CPU profile"]')).toBeNull()
})

it('preserves a usable import after bad JSON, empty samples or picker cancellation and allows same-file reselection', async () => {
  await render(); const original = localProfileFile()
  await chooseLocalProfile(original); await waitForLocalProfile(original.name)
  await chooseLocalProfile(new File(['{"private-fragment'], 'broken.cpuprofile'))
  await vi.waitFor(async () => { await act(async () => {}); expect(node('[data-performance-profile-import] [role="alert"]').textContent).toContain('not valid profile JSON') })
  expect(node('[aria-label="Imported CPU profile"]').textContent).toContain(original.name)
  expect(node('[data-performance-profile-import] [role="alert"]').textContent).not.toContain('private-fragment')
  const empty = originalProfile(); empty.samples = []; empty.timeDeltas = []
  await chooseLocalProfile(localProfileFile('empty.cpuprofile', empty))
  await vi.waitFor(async () => { await act(async () => {}); expect(node('[data-performance-profile-import] [role="alert"]').textContent).toContain('No weighted V8 samples') })
  expect(node('[aria-label="Imported CPU profile"]').textContent).toContain(original.name)
  await chooseLocalProfile(null)
  expect(node('[aria-label="Imported CPU profile"]').textContent).toContain(original.name)
  await chooseLocalProfile(original)
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[data-performance-profile-import] [role="alert"]')).toBeNull() })
  expect(node<HTMLInputElement>('[aria-label="Choose saved CPU profile"]').value).toBe('')
})

it('resets the imported flame zoom when a different original replaces the same filename', async () => {
  await render(); await chooseLocalProfile(localProfileFile()); await waitForLocalProfile('saved.cpuprofile')
  await click('[aria-label="Imported CPU profile"] .performance-module-row')
  expect(node('[aria-label="Imported CPU profile"] .performance-frame-detail').textContent).not.toContain('(root)')
  const next = originalProfile()
  for (const item of next.nodes) { item.id += 100; item.children = item.children?.map(id => id + 100) }
  next.samples = next.samples!.map(id => id + 100)
  await chooseLocalProfile(localProfileFile('saved.cpuprofile', next))
  await vi.waitFor(async () => { await act(async () => {}); expect(node('[aria-label="Imported CPU profile"] .performance-frame-detail').textContent).toContain('(root)') })
})

it('clearing a pending hash prevents its late material from replacing a later import', async () => {
  await render()
  let finish!: (bytes: ArrayBuffer) => void
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { finish = resolve }))
  await chooseLocalProfile(localProfileFile('old.cpuprofile'))
  await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce())
  await click('[data-performance-profile-import] > .performance-capture-actions > button:last-child')
  await chooseLocalProfile(localProfileFile('new.cpuprofile')); await waitForLocalProfile('new.cpuprofile')
  await act(async () => { finish(new Uint8Array(32).buffer); await Promise.resolve() })
  expect(node('[aria-label="Imported CPU profile"]').textContent).toContain('new.cpuprofile')
  expect(node('[aria-label="Imported CPU profile"]').textContent).not.toContain('old.cpuprofile')
})

it('unmount aborts the exact pending local reader and removes its callbacks', async () => {
  await render()
  let reading: FileReader | null = null
  vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (this: FileReader) {
    reading = this; Object.defineProperty(this, 'readyState', { configurable: true, value: FileReader.LOADING })
  })
  const abort = vi.spyOn(FileReader.prototype, 'abort').mockImplementation(() => {})
  await chooseLocalProfile(localProfileFile())
  expect(reading).not.toBeNull()
  await act(async () => root.render(null))
  expect(abort).toHaveBeenCalledOnce()
  expect(reading!.onload).toBeNull(); expect(reading!.onerror).toBeNull(); expect(reading!.onabort).toBeNull()
})


it('exports original native gzip bytes through the actual trace button and keeps payload out of receipts', async () => {
  const downloads: { name: string; blob: Blob }[] = [], create = vi.fn((_blob: Blob) => 'blob:original-gzip')
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: create.mock.calls.at(-1)![0] as Blob })
  })
  const decode = vi.spyOn(globalThis, 'atob')
  tracePort.mockImplementation(async input => completedTrace(input))
  await render()
  expect(tracePort).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled()
  await click('[data-performance-capture] [data-performance-action="trace"]')
  const original = completedTrace(tracePort.mock.calls[0]![0]), trace = original.trace!
  expect(decode).not.toHaveBeenCalled()
  expect(node('.performance-capture-receipt').textContent).not.toContain(trace.data)
  await click('.performance-capture-result .performance-capture-actions > button:first-child')
  await click('.performance-capture-result .performance-capture-actions > button:last-child')
  expect(downloads.map(item => item.name)).toEqual(['renderer-trace.json.gz', 'renderer-capture-receipt.json'])
  expect(downloads[0]!.blob.type).toBe('application/gzip')
  expect(Buffer.from(await downloads[0]!.blob.arrayBuffer())).toEqual(Buffer.from(trace.data, 'base64'))
  expect(JSON.parse(await downloads[1]!.blob.text())).toEqual({ ...original, trace: { ...trace, data: '(export original native gzip)' } })
  expect(decode).toHaveBeenCalledOnce(); expect(tracePort).toHaveBeenCalledOnce(); expect(profilePort).not.toHaveBeenCalled()
})
