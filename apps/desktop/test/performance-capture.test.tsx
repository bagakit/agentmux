// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { RENDERER_TRACE_CATEGORIES, type RendererV8Profile, type RendererV8ProfileInput, type RendererV8ProfileResult, type RendererTraceResult } from '@agentmux/core/control'

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
import { analyseRendererProfile, profileFlameRows } from '../src/renderer/src/lib/renderer-profile-analysis'
import { registerPerformanceCaptureIpc } from '../src/main/performance-capture-ipc'
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
function unknownTrace(input: RendererV8ProfileInput): RendererTraceResult { return { ...input, schema: 'agentmux.renderer-trace.v1', scope: 'chromium-target-related-timeline', status: 'unknown',
    transferMode: 'ReportEvents', traceTimeUnit: 'microseconds', requestedCategories: [...RENDERER_TRACE_CATEGORIES],
    timing: { requestedAt: _historyFixtureEpoch(0, 0, 1), startedAt: _historyFixtureEpoch(0, 0, 2), endAcknowledgedAt: null, completedAt: null, finishedAt: _historyFixtureEpoch(0, 0, 3), startMonotonicMs: 1, endMonotonicMs: null, completeMonotonicMs: null },
    sourceVerified: { before: true, after: false }, lifecycle: { startRequested: true, startAcknowledged: true, endRequested: true, endAcknowledged: false, tracingComplete: false, dataLossOccurred: null, detached: 'unconfirmed' },
    bufferUsage: { observations: 0, maxFraction: null, fullObserved: false }, receivedEvents: 0, receivedTraceBytes: 18, trace: null, traceBytes: null, sha256: null, issues: [] } }

let root: Root, container: HTMLDivElement, initial: ReturnType<typeof useAppStore.getState>
let profilePort: ReturnType<typeof vi.fn>, tracePort: ReturnType<typeof vi.fn>
const handlers = new Map<string, (event: never, input: unknown) => unknown>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); initial = useAppStore.getState()
  profilePort = vi.fn(async (input: RendererV8ProfileInput) => capture(input)); tracePort = vi.fn()
  handlers.clear(); registerPerformanceCaptureIpc({ captureProfile: profilePort, captureTrace: tracePort, subscribe: vi.fn() }, (channel, handler) => handlers.set(channel, handler))
  bridge.invoke.mockImplementation((channel, input) => handlers.get(channel)!(undefined as never, input))
  vi.spyOn(api.performance, 'captureProfile').mockImplementation(input => bridge.api!.performance.captureProfile(input))
  vi.spyOn(api.performance, 'captureTrace').mockImplementation(input => bridge.api!.performance.captureTrace(input))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); bridge.invoke.mockReset() })
function node<T extends HTMLElement = HTMLElement>(selector: string): T { const n = document.querySelector<T>(selector); expect(n).not.toBeNull(); expect(n!.isConnected).toBe(true); return n! }
const click = async (selector: string) => act(async () => node<HTMLButtonElement>(selector).click())
const render = async (snapshot = samples.fresh) => act(async () => root.render(<PerformanceOverview snapshot={snapshot} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />))
const sampleButton = '[data-performance-capture] .performance-capture-actions > button:first-child'

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

it('missing/stale or reused process identity cannot authorise a GUI capture; opening does no sampling', async () => {
  for (const snapshot of [samples.stale, samples.newInstance]) {
    await render(snapshot); expect(node<HTMLButtonElement>(sampleButton).disabled).toBe(true)
    await click(sampleButton)
  }
  const wrong = structuredClone(samples.fresh); wrong.observation!.renderer.data!.window.generation++
  await render(wrong); expect(node<HTMLButtonElement>(sampleButton).disabled).toBe(true)
  expect(profilePort).not.toHaveBeenCalled(); expect(tracePort).not.toHaveBeenCalled()
})

it('an in-flight explicit click is single-use, and a late original result retains its original target after readings change', async () => {
  let complete!: (value: RendererV8ProfileResult) => void
  profilePort.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await render(); await click(sampleButton); await click(sampleButton)
  expect(profilePort).toHaveBeenCalledOnce(); expect(node<HTMLButtonElement>(sampleButton).disabled).toBe(true)
  await render(samples.newInstance)
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
  expect(node('[aria-label="Module sample heatmap"]').textContent).toContain('workspace.js')
  expect(node('.performance-metrics').textContent).toContain('1.48 cores')
  const input = { target: currentPerformanceCaptureTarget(samples.fresh.observation)!, durationMs: 2000 }
  profilePort.mockImplementationOnce(async value => ({ ...capture(value), target: { ...value.target, generation: value.target.generation + 1 } }))
  await expect(bridge.api!.performance.captureProfile(input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  await expect(bridge.api!.performance.captureProfile({ ...input, durationMs: 0 })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
})

it('the timeline GUI consumes the same exact-source Main delegate and original unknown lifecycle instead of inventing rendering analysis', async () => {
  tracePort.mockImplementation(async input => unknownTrace(input))
  await render(); await click('[data-performance-capture] .performance-capture-actions > button:last-child')
  expect(bridge.invoke).toHaveBeenCalledWith('metrics:captureTrace', { target: currentPerformanceCaptureTarget(samples.fresh.observation), durationMs: 2000 })
  expect(tracePort).toHaveBeenCalledOnce(); expect(profilePort).not.toHaveBeenCalled()
  expect(node('[aria-label="Capture result"]').textContent).toContain('unconfirmed')
  expect(node('.performance-capture-receipt').textContent).toContain('"endAcknowledged": false')
  expect(document.querySelector('[aria-label="Sampled call stacks"]')).toBeNull()
})

it('export preserves original profile and original receipt byte semantics without another capture', async () => {
  const create = vi.fn((_blob: Blob) => 'blob:private-capture'), revoke = vi.fn(), downloads: { name: string; blob: Blob }[] = []
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push({ name: this.download, blob: create.mock.calls.at(-1)![0] as Blob }) })
  await render(); await click(sampleButton); await click('.performance-capture-result .performance-capture-actions > button:first-child'); await click('.performance-capture-result .performance-capture-actions > button:last-child')
  expect(downloads.map(item => item.name)).toEqual(['renderer.cpuprofile', 'renderer-capture-receipt.json'])
  expect(JSON.parse(await downloads[0]!.blob.text())).toEqual(originalProfile())
  expect(JSON.parse(await downloads[1]!.blob.text())).toEqual(capture(profilePort.mock.calls[0]![0]))
  expect(profilePort).toHaveBeenCalledOnce()
})


it('synthetic runtime module names remain whole while actual script names use their basename', async () => {
  profilePort.mockImplementation(async input => { const result = capture(input); result.profile!.nodes[1]!.callFrame.url = ''; const json = JSON.stringify(result.profile); return { ...result, profileBytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex') } })
  await render(); await click(sampleButton)
  expect(node('.performance-module-row').textContent).toContain('(runtime / no script)')
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
  await click('[data-performance-capture] > .performance-capture-actions > button:last-child')
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
  expect(JSON.parse(await downloads[2]!.blob.text())).toEqual(profileResult)
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
  const analysis = analyseRendererProfile(originalProfile()); expect(analysis.reason).toBeNull(); if (!analysis.data) throw Error('nonempty analysis required')
  expect(analysis.data.sampledMs).toBe(5); expect(analysis.data.frames.get(2)).toMatchObject({ selfMs: 2.5, totalMs: 5 })
  expect(analysis.data.modules.map(module => module.selfMs)).toEqual([2.5, 2.5])
  expect(profileFlameRows(analysis.data, 1).rows).toEqual(expect.arrayContaining([{ id: 3, depth: 2, left: 0, width: 50 }]))
  const cyclic = originalProfile(); cyclic.nodes[2]!.children = [1]
  expect(analyseRendererProfile(cyclic).data).toBeNull()
  expect(analyseRendererProfile({ ...originalProfile(), timeDeltas: [0, 0, 0] }).reason).toContain('zero')
})
