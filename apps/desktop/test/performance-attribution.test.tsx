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
import { createRendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import type { ToolkitMetricsSnapshot } from '../src/shared/toolkit'
let root: Root, container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const node = <T extends Element = HTMLElement>(selector: string) => {
  const value = document.querySelector<T>(selector); expect(value, `actual connected product node ${selector}`).not.toBeNull(); expect(value!.isConnected).toBe(true); return value!
}
const render = async (snapshot: ToolkitMetricsSnapshot, paused = false) => act(async () => root.render(<PerformanceOverview snapshot={snapshot} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} paused={paused} />))
const openRenderer = async () => act(async () => { const details = node<HTMLDetailsElement>('[data-performance-role="renderer"]'); details.open = true; details.querySelector<HTMLElement>('summary')!.focus() })

it('lazily discloses exact lifetime event types and preserves them as previous readings when paused or stale', async () => {
  let mono = 0
  const recorder = createRendererPerformance(() => mono)
  mono = 12; recorder.sessionEvent('agent-status', 0)
  mono = 42; recorder.sessionEvent('agent-session', 12)
  const sample = structuredClone(samples.fresh)
  sample.observation!.renderer.data!.performance = recorder.snapshot()
  await render(sample); await openRenderer()
  const disclosure = node<HTMLDetailsElement>('[data-performance-session-events]')
  expect(disclosure.textContent).toContain('2 calls · lifetime')
  expect(disclosure.querySelector('[data-session-event-type]')).toBeNull()
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  expect(disclosure.querySelectorAll('[data-session-event-type]')).toHaveLength(2)
  expect(disclosure.querySelector('[data-session-event-type]')?.getAttribute('data-session-event-type')).toBe('agent-session')
  expect(node('[data-session-event-type="agent-status"]').textContent).toContain('12.0 ms')
  expect(node('[data-session-event-type="agent-session"]').textContent).toContain('max 30.0 ms')
  expect(disclosure.textContent).toContain('subscribers and any layout they force')
  expect(disclosure.textContent).toContain('Later scheduled React, layout and paint are excluded')
  expect(disclosure.textContent).toContain('not CPU')
  disclosure.querySelector<HTMLElement>('summary')!.focus(); node('.performance-body').scrollTop = 90
  await render(sample, true)
  expect(node('[data-performance-session-events]')).toBe(disclosure)
  expect(document.activeElement).toBe(disclosure.querySelector('summary'))
  expect(node('.performance-body').scrollTop).toBe(90)
  expect(node('[data-session-event-type="agent-session"]').textContent).toContain('30.0 ms')
  sample.observation!.renderer.state = 'stale'; sample.observation!.renderer.reason = 'Observer is unavailable'
  await render(sample)
  expect(node('[data-renderer-memory]').textContent).toContain('Previous window reading')
  expect(node('[data-session-event-type="agent-status"]').textContent).toContain('12.0 ms')
  await act(async () => { disclosure.open = false; disclosure.dispatchEvent(new Event('toggle')) })
  expect(disclosure.querySelector('[data-session-event-type]')).toBeNull()
})

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
  expect(node('.performance-reading-time').textContent).toContain('30s old')
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

it('renders cleanup wall duration and original resource owner without write payload or release acknowledgement', async () => {
  let mono = 0
  const recorder = createRendererPerformance(() => mono)
  const owner = { hostId: 'local', sessionId: 'cleanup-session', runId: 'retiring-run', regionId: null, instanceId: 9 }
  mono = 100
  recorder.terminalCleanup(25, { ...owner, operation: 'webgl-dispose', outcome: 'returned' })
  mono = 300
  recorder.terminalCleanup(115, { ...owner, operation: 'xterm-dispose', outcome: 'threw' })
  const snapshot = structuredClone(samples.fresh)
  snapshot.observation!.renderer.data!.performance = recorder.snapshot()
  await render(snapshot); await openRenderer()
  await act(async () => { node<HTMLDetailsElement>('[data-performance-work]').open = true })
  expect(document.querySelectorAll('[data-timing-kind]')).toHaveLength(6)
  const row = node('[data-timing-kind="terminal-cleanup"]'), peak = node('[data-performance-peak="terminal-cleanup"]')
  expect(row.textContent).toContain('Synchronous dispose calls')
  expect(row.textContent).toContain('260 ms')
  expect(peak.textContent).toContain('185.0 ms')
  expect(peak.textContent).toContain('xterm-dispose')
  expect(peak.textContent).toContain('Threw')
  expect(peak.textContent).toContain('not a resource release ACK')
  expect(peak.textContent).toContain('Session cleanup-session')
  expect(peak.textContent).toContain('Run retiring-run · Region unknown · instance 9')
  expect(peak.textContent).not.toContain('bytes')
  expect(peak.textContent).not.toContain('history')
})

it('discloses current terminal instances only on demand and preserves exact live facts through refresh', async () => {
  const { terminalCostFixture } = await import('../../../packages/core/test/helpers/renderer-performance')
  const snapshot = structuredClone(samples.fresh), performance = snapshot.observation!.renderer.data!.performance
  const visible = terminalCostFixture(1), hidden = terminalCostFixture(2)
  visible.writes.live = { started: 3, completed: 2, bytes: 37, stringCodeUnits: 0, callbackWall: { count: 2, totalMs: 11, maxMs: 7 } }
  visible.renderCallbacks = 4
  hidden.visible = false; hidden.writes.checkpoint.stringCodeUnits = 9
  performance.terminals = [visible, hidden]; performance.omittedTerminals = 3; performance.unavailableTerminals = 1
  await render(snapshot); await openRenderer()
  const disclosure = node<HTMLDetailsElement>('[data-performance-terminals]')
  expect(disclosure.textContent).toContain('2 current instances')
  expect(container.querySelector('[data-terminal-instance]')).toBeNull()
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  const first = node('[data-terminal-instance="1"]'), second = node('[data-terminal-instance="2"]')
  expect(first.textContent).toContain('Host host-1Session session-1')
  expect(first.textContent).toContain('Run run-1Region region-1')
  expect(first.textContent).toContain('3 started · 2 completed37 bytes')
  expect(first.textContent).toContain('4 render callbacks')
  expect(second.textContent).toContain('Hidden · instance 2')
  expect(second.textContent).toContain('9 string code units')
  expect(disclosure.textContent).toContain('3 instances omitted · 1 unavailable')
  expect(disclosure.textContent).toContain('not CPU')
  expect(disclosure.textContent).toContain('Lifetime counts')
  const next = structuredClone(snapshot); next.observation!.renderer.data!.performance.terminals[0]!.writes.live.completed = 3
  await render(next)
  expect(node('[data-terminal-instance="1"]')).toBe(first); expect(disclosure.open).toBe(true)
  expect(first.textContent).toContain('3 started · 3 completed')
  await act(async () => { disclosure.open = false; disclosure.dispatchEvent(new Event('toggle')) })
  expect(container.querySelector('[data-terminal-instance]')).toBeNull()
})
