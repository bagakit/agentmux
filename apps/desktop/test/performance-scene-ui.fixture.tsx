// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, useState } from 'react'
import type { Root } from 'react-dom/client'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import {
  parseRendererSceneCaptureResult, rendererSceneStatus, RENDERER_ALLOCATION_POLICY, RENDERER_TRACE_CATEGORIES,
  type RendererSceneCaptureInput, type RendererSceneCaptureResult, type RendererSceneInspection,
  type RendererPerformanceScene, type RendererScenePhase, type RendererV8ProfileTarget,
} from '@agentmux/core/control'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld(_key: string, value: AgentMuxPreloadApi) { bridge.api = value } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() }, webFrame: {} }))
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { PerformancePanel } from '../src/renderer/src/components/performance/PerformancePanel'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { currentPerformanceCaptureTarget } from '../src/renderer/src/components/performance/PerformanceCapture'
import { registerPerformanceCaptureIpc } from '../src/main/performance-capture-ipc'
import { performanceAttributionSnapshots as snapshots } from '../scripts/fixtures/performance-panel/data'
import { composerConfig } from './helpers/composer-dom-fixture'
import * as profileAnalysis from '../src/renderer/src/lib/renderer-profile-analysis'

// Controlled original wire material, not a machine measurement or native sampling proof.
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const issue = (message: string) => ({ stage: 'fixture-source', code: 'CONTROL_UNAVAILABLE', message, messageTruncated: false })
const phase = <T,>(result: T): RendererScenePhase<T> => ({ status: 'completed', requestedAt: _tailFixtureEpoch(0, 0, 100), finishedAt: _tailFixtureEpoch(0, 0, 2100), result, issue: null })
const omitted = <T,>(message: string): RendererScenePhase<T> => ({ status: 'skipped', requestedAt: null, finishedAt: _tailFixtureEpoch(0, 0, 2100), result: null, issue: issue(message) })
function material(target: RendererV8ProfileTarget, captureId = 'original-scene', partial = false): RendererSceneCaptureResult {
  const profile = { startTime: 1, endTime: 2000001, samples: [2, 3], timeDeltas: [800000, 1200000], nodes: [
    { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: 'renderOriginalWorkspace', scriptId: '1', url: 'app://renderer/workspace.js', lineNumber: 1, columnNumber: 0 }, children: [3] },
    { id: 3, callFrame: { functionName: 'retainOriginalInputs', scriptId: '2', url: 'app://renderer/input.js', lineNumber: 2, columnNumber: 0 } },
  ] }
  const heap = { head: { id: 1, selfSize: 0, callFrame: profile.nodes[0]!.callFrame, children: [
    { id: 2, selfSize: 131072, callFrame: profile.nodes[2]!.callFrame, children: [] },
  ] }, samples: [{ size: 131072, nodeId: 2, ordinal: 1 }] }
  const trace = { traceEvents: [{ pid: target.pid, tid: 1, ph: 'X', ts: 1, dur: 2000, name: 'Layout', cat: 'devtools.timeline', args: { original: true } }] }
  const nativeGzip = gzipSync(JSON.stringify(trace))
  const timing = { requestedAt: _tailFixtureEpoch(0, 0, 100), startedAt: _tailFixtureEpoch(0, 0, 110), stoppedAt: _tailFixtureEpoch(0, 0, 2110), finishedAt: _tailFixtureEpoch(0, 0, 2120), startMonotonicMs: 10, stopMonotonicMs: 2010 }
  const sourceVerified = { before: true, after: true }, cleanup = { stopRequested: true, stopAcknowledged: true, disableAcknowledged: true, detached: 'confirmed' as const }
  const resources = (snapshot: typeof snapshots.fresh) => {
    const observation = structuredClone(snapshot.observation!), renderer = observation.renderer.data!, old = renderer.process
    observation.window = { windowId: target.windowId, webContentsId: target.webContentsId, generation: target.generation }
    const processIdentity = { pid: target.pid, creationTime: target.creationTime }
    renderer.window = { ...observation.window }; renderer.process = processIdentity
    observation.app.data!.processes = observation.app.data!.processes.map(process => process.pid === old.pid && process.creationTime === old.creationTime ? { ...process, ...processIdentity } : process)
    return observation
  }
  const cpu = { target, durationMs: 2000, schema: 'agentmux.renderer-v8-profile.v1' as const, scope: 'renderer-main-thread-v8' as const,
    status: 'completed' as const, timing, profilerTimeUnit: 'microseconds' as const, sourceVerified, cleanup,
    profile, profileBytes: Buffer.byteLength(JSON.stringify(profile)), sha256: hash(profile), issues: [] }
  const memory = { target, schema: 'agentmux.renderer-memory.v1' as const, scope: 'renderer-v8-isolate' as const, units: 'bytes' as const,
    status: 'completed' as const, timing: { requestedAt: _tailFixtureEpoch(0, 0, 100), sampledAt: _tailFixtureEpoch(0, 0, 110), finishedAt: _tailFixtureEpoch(0, 0, 120) }, sourceVerified,
    usage: { usedSize: 1000, totalSize: 2000, embedderHeapUsedSize: 100, backingStorageSize: 200 }, cleanup: { detached: 'confirmed' as const }, issues: [] }
  const scene: RendererPerformanceScene = { schema: 'agentmux.performance-scene.v1', captureId, target, durationMs: 2000,
    status: 'completed', requestedAt: _tailFixtureEpoch(0, 0, 100), finishedAt: _tailFixtureEpoch(0, 0, 6300), loaded: { mainPid: 1234, package: null, renderer: null },
    before: { resources: phase(resources(snapshots.fresh)), memory: phase(memory) }, cpu: phase(cpu),
    allocations: phase({ target, durationMs: 2000, status: 'completed', timing, sourceVerified, issues: [],
      schema: 'agentmux.renderer-allocations.v1', scope: 'renderer-v8-isolate-sampled-allocations',
      policy: RENDERER_ALLOCATION_POLICY, cleanup: { ...cleanup, startRequested: true, startAcknowledged: true },
      profile: heap, profileBytes: Buffer.byteLength(JSON.stringify(heap)), sha256: hash(heap) }),
    timeline: partial ? omitted('The original Renderer source changed; no replacement was sampled.') : phase({ target, durationMs: 2000,
      schema: 'agentmux.renderer-trace.v2', scope: 'chromium-target-related-timeline', status: 'completed', transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'gzip', traceTimeUnit: 'microseconds',
      requestedCategories: [...RENDERER_TRACE_CATEGORIES], sourceVerified,
      timing: { requestedAt: _tailFixtureEpoch(0, 0, 4200), startedAt: _tailFixtureEpoch(0, 0, 4210), endAcknowledgedAt: _tailFixtureEpoch(0, 0, 6210), completedAt: _tailFixtureEpoch(0, 0, 6220), finishedAt: _tailFixtureEpoch(0, 0, 6230), startMonotonicMs: 20, endMonotonicMs: 2020, completeMonotonicMs: 2030 },
      lifecycle: { startRequested: true, startAcknowledged: true, endRequested: true, endAcknowledged: true, tracingComplete: true, dataLossOccurred: false, detached: 'confirmed' },
      stream: { handleReceived: true, eof: true, closeRequested: true, closeAcknowledged: true },
      bufferUsage: { observations: 1, maxFraction: 0.01, fullObserved: false }, receivedEvents: 1, receivedTraceBytes: Buffer.byteLength(JSON.stringify(trace)),
      receivedGzipBytes: nativeGzip.length, trace: { encoding: 'base64', data: nativeGzip.toString('base64'), bytes: nativeGzip.length, sha256: createHash('sha256').update(nativeGzip).digest('hex') }, traceBytes: Buffer.byteLength(JSON.stringify(trace)), sha256: hash(trace), issues: [] }),
    after: { resources: phase(resources(snapshots.refresh)), memory: phase(memory) } }
  scene.status = rendererSceneStatus(scene)
  return parseRendererSceneCaptureResult({ scene, persistence: { status: 'confirmed', phase: null, issue: null } }, { target })
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no }), resolve, reject } }
function Fixture() {
  const [selectedToolId, onSelectTool] = useState<string | symbol | null>(null)
  return <SettingsNavigation.Provider value={{ open() {}, openToolkit() {}, openHost() {}, openLark() {}, openMoteLark() {}, chooseAgent() {} }}><PerformancePanel selectedToolId={selectedToolId} onSelectTool={onSelectTool} /></SettingsNavigation.Provider>
}
let root: Root, container: HTMLDivElement, initial: ReturnType<typeof useAppStore.getState>
let capturePort: ReturnType<typeof vi.fn>, inspectPort: ReturnType<typeof vi.fn>, latest: RendererSceneCaptureResult | null
let observe: ((value: typeof snapshots.fresh) => void) | undefined
const handlers = new Map<string, (event: never, input: unknown) => unknown>()
const target = () => currentPerformanceCaptureTarget(snapshots.fresh.observation)!
const sceneNode = () => document.querySelector<HTMLElement>('[aria-label="Performance scene"]')!
const button = (name: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === name)!
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
const click = async (element: HTMLElement) => { expect(element).toBeDefined(); expect(element.isConnected).toBe(true); await act(async () => element.click()); await settle() }
const open = async () => { await click(document.querySelector<HTMLButtonElement>('.performance-trigger')!); expect(sceneNode()).not.toBeNull() }
const close = async () => { await click(document.querySelector<HTMLButtonElement>('[data-toolkit-close]')!); expect(sceneNode()).toBeNull() }
const collect = async () => click(sceneNode().querySelector<HTMLButtonElement>('[data-performance-scene-capture]')!)
const render = async () => { await act(async () => root.render(<Fixture />)); await settle() }
beforeEach(async () => {
  expect(homedir()).toBe(process.env.AGENTMUX_SCENE_UI_PRIVATE_HOME)
  for (const key of ['HOME', 'CODEX_HOME', 'AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY']) expect(process.env[key]).toContain(process.env.AGENTMUX_SCENE_UI_PRIVATE_ROOT)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container); initial = useAppStore.getState()
  useAppStore.setState({ config: { ...composerConfig, toolkit: { performance: { enabled: true, statusBar: 'label' } } } })
  latest = null; observe = undefined
  capturePort = vi.fn(async (input: RendererSceneCaptureInput) => { latest = material(input.target); return latest })
  inspectPort = vi.fn(async (): Promise<RendererSceneInspection> => latest ? { status: 'available', scene: latest.scene, issue: null } : { status: 'absent', scene: null, issue: null })
  handlers.clear(); registerPerformanceCaptureIpc({ captureScene: capturePort, inspectScene: inspectPort, subscribe: vi.fn() }, (channel, handler) => handlers.set(channel, handler))
  bridge.invoke.mockImplementation((channel, input) => { expect(handlers.has(channel), `Registered Main channel ${channel}`).toBe(true); return handlers.get(channel)!(undefined as never, input) })
  vi.spyOn(api.performance, 'captureScene').mockImplementation(input => bridge.api!.performance.captureScene(input))
  vi.spyOn(api.performance, 'inspectScene').mockImplementation(input => bridge.api!.performance.inspectScene(input))
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, listener) => { observe = listener; listener(snapshots.fresh); return { dispose() {} } })
  await render()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); bridge.invoke.mockReset() })

it('opens the actual Panel with inspect only and sends one exact scene click through preload and the registered Main delegate', async () => {
  expect(inspectPort).not.toHaveBeenCalled(); expect(capturePort).not.toHaveBeenCalled()
  await open(); expect(inspectPort).toHaveBeenCalledExactlyOnceWith({}); expect(capturePort).not.toHaveBeenCalled()
  await collect()
  expect(capturePort).toHaveBeenCalledExactlyOnceWith({ target: target() })
  expect(bridge.invoke).toHaveBeenCalledWith('metrics:captureScene', { target: target() })
  expect(sceneNode().textContent).toContain('Scene captured'); expect(sceneNode().textContent).toContain('Saved locally')
  expect(sceneNode().textContent).toContain('version unknown')
})

it('missing or reused current identity cannot start capture while existing observations stay readable', async () => {
  await open()
  for (const snapshot of [snapshots.stale, snapshots.newInstance]) {
    await act(async () => observe!(snapshot)); await settle()
    const action = sceneNode().querySelector<HTMLButtonElement>('[data-performance-scene-capture]')!
    expect(action.disabled).toBe(true); await click(action)
    expect(sceneNode().textContent).toContain('identity is unconfirmed')
    expect(document.querySelector('.performance-metrics')).not.toBeNull()
  }
  expect(capturePort).not.toHaveBeenCalled()
})

it('keeps a busy request single-use through close/reopen and attributes a late scene to its original target', async () => {
  const waiting = deferred<RendererSceneCaptureResult>(); capturePort.mockReturnValue(waiting.promise)
  await open(); await collect(); expect(capturePort).toHaveBeenCalledOnce()
  expect(sceneNode().querySelector<HTMLButtonElement>('[data-performance-scene-capture]')!.disabled).toBe(true)
  await collect(); await close(); await open(); expect(capturePort).toHaveBeenCalledOnce(); expect(inspectPort).toHaveBeenCalledOnce()
  const changed = structuredClone(snapshots.fresh), renderer = changed.observation!.renderer.data!, old = renderer.process
  const changedIdentity = { pid: old.pid! + 10, creationTime: old.creationTime! + 1 }
  renderer.process = changedIdentity; changed.observation!.window!.generation++; renderer.window.generation++
  changed.observation!.app.data!.processes = changed.observation!.app.data!.processes.map(p => p.pid === old.pid && p.creationTime === old.creationTime ? { ...p, ...changedIdentity } : p)
  await act(async () => observe!(changed)); await settle()
  latest = material(target()); await act(async () => waiting.resolve(latest!)); await settle()
  expect(sceneNode().textContent).toContain('Showing the original process'); expect(sceneNode().textContent).toContain(`PID ${target().pid}`)
  await close(); await open(); expect(inspectPort).toHaveBeenCalledTimes(2); expect(capturePort).toHaveBeenCalledOnce()
  expect(sceneNode().textContent).toContain('Scene captured')
})

it('a remounted Panel reads material completed after it unmounted without recapturing or claiming an old durability ACK', async () => {
  const waiting = deferred<RendererSceneCaptureResult>(); capturePort.mockReturnValue(waiting.promise)
  await open(); await collect(); await act(async () => root.render(null))
  latest = material(target()); await act(async () => waiting.resolve(latest!)); await render(); await open()
  expect(capturePort).toHaveBeenCalledOnce(); expect(inspectPort).toHaveBeenCalledTimes(2)
  expect(sceneNode().textContent).toContain('Scene captured')
  expect(sceneNode().textContent).toContain('original save durability acknowledgement is not available')
})

it('exports partial save-unknown scene and each available original profile without collecting another scene', async () => {
  const original = material(target(), 'partial-original-scene', true)
  original.persistence = { status: 'unknown', phase: 'after-replace', issue: issue('The replacement fsync reply is unconfirmed.') }
  capturePort.mockResolvedValue(original)
  const downloads: { name: string; blob: Blob }[] = [], blobs: Blob[] = []
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { blobs.push(blob); return 'blob:scene-original' }
    static revokeObjectURL() {}
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push({ name: this.download, blob: blobs.at(-1)! }) })
  await open(); await collect()
  expect(sceneNode().textContent).toContain('Scene partial'); expect(sceneNode().textContent).toContain('local file may have changed')
  expect(sceneNode().textContent).toContain('no replacement was sampled')
  for (const name of ['Export scene', 'CPU profile', 'Allocation profile']) await click(button(name, sceneNode()))
  expect(button('Timeline', sceneNode())).toBeUndefined()
  expect(downloads.map(x => x.name)).toEqual(['performance-scene.json', 'renderer.cpuprofile', 'renderer.heapprofile'])
  expect(await downloads[0]!.blob.text()).toBe(JSON.stringify(original))
  expect(await downloads[1]!.blob.text()).toBe(JSON.stringify(original.scene.cpu.result!.profile))
  expect(await downloads[2]!.blob.text()).toBe(JSON.stringify(original.scene.allocations.result!.profile))
  expect(sceneNode().textContent).toContain('Download requested. Check your selected destination')
  expect(sceneNode().textContent).not.toContain('leak detected'); expect(capturePort).toHaveBeenCalledOnce()
})

it('an inspect failure keeps completed material in hand and permits original exports', async () => {
  await open(); await collect(); await close(); inspectPort.mockRejectedValueOnce(new Error('The original local scene file is unreadable'))
  await open()
  expect(sceneNode().textContent).toContain('The original local scene file is unreadable')
  expect(sceneNode().textContent).toContain('Scene captured'); expect(button('Export scene', sceneNode())).toBeDefined()
  expect(capturePort).toHaveBeenCalledOnce()
})

it('analyses the original CPU and allocation material only while the corresponding disclosure is open', async () => {
  await open(); await collect()
  expect(sceneNode().querySelector('.performance-capture-result')).toBeNull()
  expect(sceneNode().querySelector('.performance-flame')).toBeNull()
  expect(sceneNode().querySelector('.performance-allocation-list')).toBeNull()
  for (const label of ['JavaScript modules and flame graph', 'Sampled allocation stacks']) {
    const details = [...sceneNode().querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent === label)!
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) }); await settle()
    expect(sceneNode().textContent).toContain(label === 'Sampled allocation stacks' ? 'retainOriginalInputs' : 'renderOriginalWorkspace')
    if (label === 'JavaScript modules and flame graph') expect(sceneNode().querySelector('.performance-flame')).not.toBeNull()
    if (label === 'Sampled allocation stacks') expect(sceneNode().querySelector('.performance-allocation-list')).not.toBeNull()
    await act(async () => { details.open = false; details.dispatchEvent(new Event('toggle')) }); await settle()
  }
  expect(sceneNode().querySelector('.performance-allocation-list')).toBeNull()
  expect(sceneNode().querySelector('.performance-capture-result')).toBeNull()
  expect(capturePort).toHaveBeenCalledOnce()
})

it('does not reanalyse the same open profile on unrelated metrics refresh but analyses a new explicit result', async () => {
  const analyse = vi.spyOn(profileAnalysis, 'analyseRendererProfile')
  await open(); await collect(); expect(analyse).not.toHaveBeenCalled()
  const details = [...sceneNode().querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent === 'JavaScript modules and flame graph')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) }); await settle()
  expect(analyse).toHaveBeenCalledTimes(1)
  expect(sceneNode().querySelector('.performance-flame')).not.toBeNull()
  const originalProfile = analyse.mock.calls[0]![0]
  await act(async () => observe!(structuredClone(snapshots.refresh))); await settle()
  expect(analyse).toHaveBeenCalledTimes(1)
  expect(sceneNode().querySelector('.performance-flame')).not.toBeNull()
  await collect()
  expect(capturePort).toHaveBeenCalledTimes(2); expect(analyse).toHaveBeenCalledTimes(2)
  expect(analyse.mock.calls[1]![0]).not.toBe(originalProfile)
})

it.each(['failed', 'unknown'] as const)('keeps an unsaved %s result when reinspection reads the previous file', async status => {
  const previous = material(target(), 'previous-file'), unsaved = material(target(), 'only-copy-in-hand', true)
  unsaved.persistence = { status, phase: status === 'failed' ? 'before-replace' : 'after-replace', issue: issue('Original save was not confirmed.') }
  capturePort.mockResolvedValue(unsaved)
  await open(); await collect(); expect(sceneNode().textContent).toContain('Scene partial')
  await close(); latest = previous; await open()
  expect(sceneNode().textContent).toContain('only-copy-in-hand'); expect(sceneNode().textContent).not.toContain('previous-file')
  expect(sceneNode().textContent).toContain(status === 'failed' ? 'previous file is preserved' : 'local file may have changed')
  expect(sceneNode().textContent).toContain('different scene')
  expect(capturePort).toHaveBeenCalledOnce()
})

it('an older inspect reply cannot erase a newer explicit scene and a wrong-target reply preserves the original material', async () => {
  const reading = deferred<RendererSceneInspection>(); inspectPort.mockReturnValueOnce(reading.promise)
  await open(); await collect(); expect(sceneNode().textContent).toContain('Scene captured')
  await act(async () => reading.resolve({ status: 'absent', scene: null, issue: null })); await settle()
  expect(sceneNode().textContent).toContain('Scene captured')
  capturePort.mockResolvedValueOnce(material({ ...target(), generation: target().generation + 1 }, 'foreign-source'))
  await collect(); expect(sceneNode().textContent).toContain('contract is invalid')
  expect(sceneNode().textContent).toContain('Scene captured'); expect(sceneNode().textContent).not.toContain('foreign-source')
  expect(capturePort).toHaveBeenCalledTimes(2)
})


it('exports the retained scene timeline as the same original gzip without decoding it on inspect or open', async () => {
  const original = material(target()), trace = original.scene.timeline.result!.trace!
  latest = original
  const downloads: { name: string; blob: Blob }[] = [], blobs: Blob[] = []
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { blobs.push(blob); return 'blob:scene-native-gzip' }
    static revokeObjectURL() {}
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.at(-1)! })
  })
  const decode = vi.spyOn(globalThis, 'atob')
  await open()
  expect(capturePort).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled()
  await click(button('Timeline', sceneNode()))
  expect(downloads.map(item => item.name)).toEqual(['renderer-trace.json.gz'])
  expect(downloads[0]!.blob.type).toBe('application/gzip')
  expect(Buffer.from(await downloads[0]!.blob.arrayBuffer())).toEqual(Buffer.from(trace.data, 'base64'))
  expect(decode).toHaveBeenCalledOnce(); expect(capturePort).not.toHaveBeenCalled()
})
