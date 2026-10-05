// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { PerformanceOverview } from '../src/renderer/src/components/performance/PerformanceOverview'
import { performanceAttributionSnapshots as samples } from '../scripts/fixtures/performance-panel/data'
import type { ToolkitMetricsSnapshot } from '../src/shared/toolkit'
let root: Root, container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const node = <T extends Element = HTMLElement>(selector: string) => {
  const value = document.querySelector<T>(selector); expect(value, `actual connected product node ${selector}`).not.toBeNull(); expect(value!.isConnected).toBe(true); return value!
}
const render = async (snapshot: ToolkitMetricsSnapshot, paused = false) => act(async () => root.render(<PerformanceOverview snapshot={snapshot} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} paused={paused} />))
const openRenderer = async () => act(async () => { const details = node<HTMLDetailsElement>('[data-performance-role="renderer"]'); details.open = true; details.querySelector<HTMLElement>('summary')!.focus() })

it('actual Overview consumes two-level process facts with independent CPU windows, cores, RSS and isolate heap', async () => {
  await render(samples.fresh); await openRenderer()
  const map = node('[aria-label="Process heatmap"]')
  expect(map.textContent).toContain('14 logical cores on host')
  const group = node('[data-performance-role="renderer"] > summary')
  expect(group.textContent).toContain('126.0%'); expect(group.textContent).toContain('1.26 cores')
  const process = node('[data-process-pid="2345"]')
  expect(process.textContent).toContain('114.6%'); expect(process.textContent).toContain('1.15 cores'); expect(process.textContent).toContain('1.80 GiB')
  expect(process.textContent).toContain('1.0s interval')
  expect(map.textContent).toContain('not the group’s 10s peak')
  const heap = node('[data-renderer-memory]')
  expect(heap.textContent).toContain('768 MiB'); expect(heap.textContent).toContain('One V8 isolate')
  expect(heap.textContent).toContain('native RSS attribution is unknown')
  expect(node('.performance-metrics').textContent).toContain('1.48 cores')
  expect(group.querySelector('.performance-heat-cell')!.getAttribute('style')).toContain('--heat-intensity')
})

it('refresh preserves exact process nodes, expanded group, focus and scroll; PID reuse is a new instance and cannot join old heap', async () => {
  await render(samples.fresh); await openRenderer()
  const group = node<HTMLDetailsElement>('[data-performance-role="renderer"]'), summary = group.querySelector('summary')!, process = node('[data-process-pid="2345"]')
  node('.performance-body').scrollTop = 120
  await render(samples.refresh)
  expect(node('[data-process-pid="2345"]')).toBe(process); expect(group.open).toBe(true); expect(document.activeElement).toBe(summary)
  expect(node('.performance-body').scrollTop).toBe(120); expect(process.textContent).toContain('118.0%')
  await render(samples.newInstance)
  expect(node('[data-process-pid="2345"]')).not.toBe(process)
  expect(container.querySelector('[data-renderer-memory]')).toBeNull()
  expect(group.textContent).toContain('could not be matched')
  const oldWindow = structuredClone(samples.fresh); oldWindow.observation!.renderer.data!.window.generation++
  await render(oldWindow)
  expect(container.querySelector('[data-renderer-memory]')).toBeNull()
})

it('stale and paused sources retain values without live heat; new envelope does not freshen old readings', async () => {
  await render(samples.fresh); await openRenderer()
  expect(node('[data-performance-role="renderer"] > summary .performance-heat-cell').getAttribute('style')).toContain('--heat-intensity')
  await render(samples.stale)
  expect(node('.performance-observation').textContent).toContain('30s old')
  expect(node('[data-performance-role="renderer"] > summary').textContent).toContain('126.0%')
  expect(node('[data-performance-role="renderer"] > summary .performance-heat-cell').getAttribute('style') ?? '').not.toContain('--heat-intensity')
  await render(samples.fresh, true)
  expect(node('.performance-status').textContent).toBe('Paused here')
  expect(node('[data-performance-role="renderer"] > summary .performance-heat-cell').getAttribute('style') ?? '').not.toContain('--heat-intensity')
})

it('heap failure and unknown CPU keep unrelated facts readable, omissions explicit; absent CPU basis never invents core equivalents', async () => {
  const sample = structuredClone(samples.unknown)
  sample.observation!.app.data!.omittedProcesses = 3
  await render(sample); await openRenderer()
  expect(node('[data-renderer-memory]').textContent).toContain('Heap unavailable')
  expect(node('[data-process-pid="2345"]').textContent).toContain('1.80 GiB')
  expect(node('[data-process-pid="2345"]').textContent).toContain('CPU unknown')
  expect(node('[data-process-pid="2345"]').textContent).not.toContain('Basis unknown')
  expect(node('[aria-label="Process heatmap"]').textContent).toContain('3 process details omitted')
  expect(node('[data-performance-work]').textContent).toContain('Current period')
  const unconfirmed = structuredClone(samples.fresh)
  delete (unconfirmed.observation!.units as { cpuBasis?: string }).cpuBasis
  await render(unconfirmed)
  expect(node('[data-process-pid="2345"]').textContent).toContain('Basis unknown')
  expect(node('[data-process-pid="2345"]').textContent).not.toContain('1.15 cores')
})

it('work/wait uses the retained previous period, shows overlapping wall scope and incomplete observer support', async () => {
  await render(samples.waiting); await openRenderer()
  const work = node('[data-performance-work]')
  expect(work.textContent).toContain('Current period')
  await act(async () => node<HTMLButtonElement>('[data-performance-period=previous]').click())
  expect(work.textContent).toContain('Previous period'); expect(work.textContent).toContain('8.5s observed')
  expect(work.textContent).toContain('Wall times overlap; they are not CPU shares')
  expect(node('[data-timing-kind="session-event"]').textContent).toContain('123 ms')
  expect(node('[data-timing-kind="terminal-write"]').textContent).toContain('520 ms')
  expect(node('[data-timing-kind="long-task"]').textContent).toContain('No samples')
  expect(node('[data-timing-kind="long-task"]').textContent).toContain('stopped')
})


it('actual App Toolkit API stream feeds the heatmap and pause releases only its UI lease', async () => {
  const initial = useAppStore.getState(), release = vi.fn()
  let publish: (value: ToolkitMetricsSnapshot) => void = () => {}
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, callback) => {publish = callback;callback(samples.fresh);return {dispose:release}})
  const run = vi.spyOn(api.toolkit, 'run'), stop = vi.spyOn(api.toolkit, 'stop')
  try {
    useAppStore.setState({...initial,config:{...composerConfig,toolkit:{performance:{enabled:true,statusBar:'label'}}},loading:false,
      initialize:async()=>()=>{},detectExecutors:vi.fn(async()=>{}),checkHost:vi.fn(async()=>{}),sessions:[composerSession('attribution-session')],
      providerCatalog:await api.providers.list(),mainSurface:'workbench',toolsOpen:false,tabs:{},layouts:{}},true)
    await act(async () => root.render(<App />))
    await act(async () => node<HTMLButtonElement>('.performance-trigger').click())
    expect(api.toolkit.observe).toHaveBeenCalledTimes(1)
    await openRenderer()
    const process = node('[data-process-pid="2345"]')
    await act(async () => publish(samples.refresh))
    expect(node('[data-process-pid="2345"]')).toBe(process)
    expect(process.textContent).toContain('118.0%')
    await act(async () => node<HTMLButtonElement>('[data-performance-observation-toggle]').click())
    expect(release).toHaveBeenCalledTimes(1)
    expect(node('.performance-status').textContent).toBe('Paused here')
    expect(run).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled()
  } finally {await act(async () => root.unmount());root = createRoot(container);useAppStore.setState(initial,true);vi.restoreAllMocks()}
})


it('expanded Work and wait consumes only the selected epoch peak and its exact context while refresh preserves focus', async () => {
  await render(samples.waiting); await openRenderer()
  const work = node<HTMLDetailsElement>('[data-performance-work]'); work.open = true
  expect(node('[data-performance-peak="terminal-write"]').textContent).toContain('No retained slow event')
  await act(async () => node<HTMLButtonElement>('[data-performance-period=previous]').click())
  const peak = node('[data-performance-peak="terminal-write"]')
  expect(peak.textContent).toContain('Peak #')
  expect(peak.textContent).toContain('520.0 ms')
  expect(peak.textContent).toContain('history · 7 string-code-units')
  expect(peak.textContent).toContain('Host local · Session preparation-session')
  expect(peak.textContent).toContain('Run preparation-run · Region preparation-region · instance 1')
  expect(node('[data-performance-peak="session-event"]').textContent).toContain('Renderer-wide · terminal owner unknown')
  const button = node<HTMLButtonElement>('[data-performance-period=previous]'); button.focus()
  node('.performance-body').scrollTop = 90
  await render(samples.waiting, true)
  expect(work.open).toBe(true); expect(document.activeElement).toBe(button)
  expect(node('.performance-body').scrollTop).toBe(90)
  expect(node('[data-performance-peak="terminal-write"]').textContent).toBe(peak.textContent)
  expect(node('[data-timing-kind="terminal-write"]').getAttribute('style') ?? '').not.toContain('--heat-intensity')
})
