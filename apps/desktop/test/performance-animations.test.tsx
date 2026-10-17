// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RendererAnimationsResult } from '@agentmux/core/control'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld(_key: string, value: AgentMuxPreloadApi) { bridge.api = value } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() }, webFrame: {} }))
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { PerformanceOverview } from '../src/renderer/src/components/performance/PerformanceOverview'
import { currentPerformanceCaptureTarget } from '../src/renderer/src/components/performance/PerformanceCapture'
import { RendererAnimationInspector, RENDERER_ANIMATIONS_PROGRAM } from '../src/main/renderer-animations'
import { createResourceMetricsPort } from '../src/main/resource-usage-control'
import type { ProcessResourceSampler } from '../src/main/process-resource-sampler'
import { registerPerformanceCaptureIpc } from '../src/main/performance-capture-ipc'
import { performanceAttributionSnapshots as samples } from '../scripts/fixtures/performance-panel/data'

const snapshot = (): NonNullable<RendererAnimationsResult['snapshot']> => ({
  totalAnimations: 2, omittedAnimations: 0, animations: [
    { kind: 'css-animation', name: 'fixture-motion', playState: 'running', pending: false, currentTime: 12,
      duration: 1400, iterations: 'infinite', ancestry: ['span.fixture-motion', 'button.fixture-owner'], stringsTruncated: false, targetTruncated: false },
    { kind: 'web-animation', name: null, playState: 'paused', pending: false, currentTime: null,
      duration: 'auto', iterations: 1, ancestry: ['span.' + 'x'.repeat(123)], stringsTruncated: true, targetTruncated: true }
  ]
})
let root: Root, container: HTMLDivElement
let inspector: RendererAnimationInspector, port: ReturnType<typeof createResourceMetricsPort>
let current: ReturnType<typeof currentPerformanceCaptureTarget>, evaluate: ReturnType<typeof vi.fn>
let last: RendererAnimationsResult | undefined
const handlers = new Map<string, (event: never, input: unknown) => unknown>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  current = currentPerformanceCaptureTarget(samples.fresh.observation)
  evaluate = vi.fn(async () => snapshot())
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScript: evaluate })
  inspector = new RendererAnimationInspector(contents as unknown as WebContents, () => current)
  port = createResourceMetricsPort({ sampler: {} as ProcessResourceSampler, currentWindow: () => samples.fresh.observation!.window, animations: inspector })
  const original = inspector.inspect.bind(inspector)
  vi.spyOn(inspector, 'inspect').mockImplementation(async (input, signal) => { last = await original(input, signal); return last })
  handlers.clear(); registerPerformanceCaptureIpc(port, (name, handler) => handlers.set(name, handler))
  bridge.invoke.mockImplementation((name, input) => handlers.get(name)!(undefined as never, input))
  vi.spyOn(api.performance, 'inspectAnimations').mockImplementation(input => bridge.api!.performance.inspectAnimations(input))
  last = undefined
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); port.dispose()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); bridge.invoke.mockReset()
})
const button = () => container.querySelector<HTMLButtonElement>('[data-performance-action="animations"]')!
const render = async (value = samples.fresh) => act(async () => root.render(<PerformanceOverview snapshot={value} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />))
const click = async () => act(async () => button().click())

it('reads once through the mounted Performance, preload, registered handler and original Main metrics owner; exports exact facts', async () => {
  const downloads: { name: string; blob: Blob }[] = [], create = vi.fn((_blob: Blob) => 'blob:animation-inspection')
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: create.mock.calls.at(-1)![0] as Blob })
  })
  await render(); expect(evaluate).not.toHaveBeenCalled()
  await act(async () => container.querySelector<HTMLElement>('[data-performance-capture] > summary')!.click())
  expect(evaluate).not.toHaveBeenCalled(); await click()
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith('metrics:inspectAnimations', { target: current })
  expect(inspector.inspect).toHaveBeenCalledExactlyOnceWith({ target: current }, undefined)
  expect(evaluate).toHaveBeenCalledExactlyOnceWith(RENDERER_ANIMATIONS_PROGRAM, false)
  const result = container.querySelector('[aria-label="Animation inspection result"]')!
  expect(result.textContent).toContain('fixture-motion · running')
  expect(result.textContent).toContain('infinite'); expect(result.textContent).toContain('auto')
  expect(result.textContent).toContain('2 observed · 2 returned · 0 omitted')
  expect(result.textContent).toContain('span.fixture-motion ← button.fixture-owner')
  expect(result.textContent).toContain('Some labels or element ancestry were shortened.')
  expect(last?.status).toBe('completed')
  await act(async () => result.querySelector<HTMLButtonElement>('.performance-capture-actions > button')!.click())
  expect(downloads).toHaveLength(1); expect(downloads[0]!.name).toBe('renderer-animations.json')
  expect(JSON.parse(await downloads[0]!.blob.text())).toEqual(last)
  expect(evaluate).toHaveBeenCalledOnce()
})

it('keeps a pending read on its original source and busy boundary when the observed Renderer changes', async () => {
  let settle!: (value: ReturnType<typeof snapshot>) => void
  evaluate.mockImplementation(() => new Promise(resolve => { settle = resolve }))
  await render(); await click()
  expect(button().disabled).toBe(true)
  expect([...container.querySelectorAll<HTMLButtonElement>('[data-performance-action]')].every(value => value.disabled)).toBe(true)
  const changed = structuredClone(samples.fresh), observation = changed.observation!, renderer = observation.renderer.data!
  const previous = renderer.process, replacement = { pid: previous.pid! + 1, creationTime: previous.creationTime! + 1 }
  renderer.process = replacement; observation.window!.generation++; renderer.window.generation++
  observation.app.data!.processes = observation.app.data!.processes.map(p => p.pid === previous.pid && p.creationTime === previous.creationTime ? { ...p, ...replacement } : p)
  current = currentPerformanceCaptureTarget(observation)
  await render(changed); expect(button().disabled).toBe(true)
  await act(async () => settle(snapshot()))
  const result = container.querySelector('[aria-label="Animation inspection result"]')!
  expect(result.textContent).toContain('unknown')
  expect(result.textContent).toContain('Showing the original inspected process')
  expect(result.textContent).not.toContain('fixture-motion')
  expect(last?.target).toEqual(currentPerformanceCaptureTarget(samples.fresh.observation))
  expect(evaluate).toHaveBeenCalledOnce()
})

it('does not evaluate stale or unconfirmed process targets', async () => {
  await render(samples.stale); expect(button().disabled).toBe(true); await click()
  expect(evaluate).not.toHaveBeenCalled()
  await render(); expect(button().disabled).toBe(false)
  await render(samples.newInstance); expect(button().disabled).toBe(true); await click()
  expect(evaluate).not.toHaveBeenCalled()
})

it('shows the original native failure without retrying or clearing other observation controls', async () => {
  evaluate.mockRejectedValue(new Error('Fixture animation read unavailable'))
  await render(); await click()
  expect(container.querySelector('[aria-label="Animation inspection result"]')?.textContent).toContain('failed')
  expect(container.textContent).toContain('Fixture animation read unavailable')
  expect(button().disabled).toBe(false)
  expect(container.querySelector<HTMLButtonElement>('[data-performance-action="profile"]')!.disabled).toBe(false)
  expect(evaluate).toHaveBeenCalledOnce()
})
