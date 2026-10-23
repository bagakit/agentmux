// @vitest-environment happy-dom
import { act, useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createInputPerformanceRecorder, hostedCarrierPerformance } from '@agentmux/core'
import { parseMetricsObservation, type HostMetric } from '@agentmux/core/control'
import { PerformanceOverview } from '../src/renderer/src/components/performance/PerformanceOverview'
import { ToolkitPopover } from '../src/renderer/src/components/performance/PerformancePopover'
import { api } from '../src/renderer/src/lib/api'
import { performanceSnapshot } from '../scripts/fixtures/performance-panel/data'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const dom = composerDOM(), GiB = 1073741824
function snapshot() {
  const value = structuredClone(performanceSnapshot), at = value.observedAt!, observed = value.observation!
  const measured = <T,>(data: T): HostMetric<T> => ({ observedAt: at, data, unavailable: null })
  observed.diagnostics = { state: 'available', observedAt: at, lastSuccessAt: at, reason: null, data: {
    main: { processId: observed.scope.mainPid, observedAt: at, input: createInputPerformanceRecorder().snapshot(), carrier: hostedCarrierPerformance.snapshot() },
    hosts: [], omittedHosts: 0, storage: { location: 'main-user-home-volume', availableBytes: 19 * GiB, totalBytes: 512 * GiB }, storageUnavailable: null,
    eventLoop: { resolutionMs: 20, generation: 1, count: 1, meanMs: 1, maxMs: 1 },
    host: { cpu: measured({ basis: 'whole-host-capacity', percent: 23.5, intervalMs: 1000, logicalCpuCount: 8, unavailable: null }),
      memory: measured({ source: 'node-os', totalBytes: 32 * GiB, freeBytes: 2 * GiB }),
      swap: measured({ source: 'darwin-sysctl', usedBytes: GiB, totalBytes: 2 * GiB }),
      pressure: measured({ source: 'darwin-sysctl', level: 'warning' }),
      network: measured({ source: 'darwin-netstat-link', interfaces: [
        { name: 'en0', linkId: 1, receivedBytes: 16384, sentBytes: 8192, receiveBytesPerSecond: 2048, sendBytesPerSecond: 1024, intervalMs: 5000, unavailable: null },
        { name: 'utun0', linkId: 2, receivedBytes: 16384, sentBytes: 8192, receiveBytesPerSecond: 2048, sendBytesPerSecond: 1024, intervalMs: 5000, unavailable: null }
      ] }) }
  } }
  // Exact public parsing prevents this UI proof from accepting a hand-waved shape.
  parseMetricsObservation(observed)
  return value
}
function node<T extends HTMLElement = HTMLElement>(selector: string) {
  const value = document.querySelector<T>(selector); expect(value, selector).not.toBeNull(); expect(value!.isConnected).toBe(true); return value!
}
const click = async (selector: string) => act(async () => node<HTMLButtonElement>(selector).click())
const render = (value = snapshot()) => dom.render(<PerformanceOverview snapshot={value} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />)
const tab = (section: string) => `[data-performance-section-tab="${section}"]`
beforeEach(() => { vi.spyOn(api.performance, 'captureProfile'); vi.spyOn(api.performance, 'captureTrace'); vi.spyOn(api.performance, 'captureScene'); vi.spyOn(api.performance, 'captureHeapSnapshot') })

it('starts with a scoped overview and exposes the original resource owners only from Resources', async () => {
  await render()
  expect(node<HTMLButtonElement>(tab('overview')).getAttribute('aria-selected')).toBe('true')
  expect(node<HTMLElement>('[data-performance-section="resources"]').hidden).toBe(true)
  const overview = node('[data-performance-section="overview"]')
  expect(overview.textContent).toContain('23.5%'); expect(overview.textContent).toContain('19.0 GiB')
  expect(overview.textContent).toContain('Home volume'); expect(overview.textContent).toContain('18.4%')
  expect(overview.textContent).toContain('not a whole-computer total')
  await click(tab('resources')); expect(node<HTMLElement>('[data-performance-section="resources"]').hidden).toBe(false)
  await click('[data-settings-target="runs"]'); expect(node('[data-run-totals]').textContent).toContain('All tracked Runs')
  await click('[data-settings-target="runtime"]'); expect(node('.performance-runtime').textContent).toContain('ctxmux')
  await click(tab('diagnostics')); expect(node<HTMLElement>('[data-performance-section="diagnostics"]').hidden).toBe(false)
  expect(node('[data-performance-capture]').isConnected).toBe(true)
  await click(tab('artifacts')); expect(node('[data-performance-profile-import]').isConnected).toBe(true)
  expect(api.performance.captureProfile).not.toHaveBeenCalled(); expect(api.performance.captureTrace).not.toHaveBeenCalled()
  expect(api.performance.captureScene).not.toHaveBeenCalled(); expect(api.performance.captureHeapSnapshot).not.toHaveBeenCalled()
})

it('switches accessible sections by keyboard and restores each section reading position', async () => {
  await render()
  const body = node('.performance-body'); body.scrollTop = 120
  await act(async () => body.dispatchEvent(new Event('scroll', { bubbles: true })))
  await act(async () => node(tab('overview')).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(document.activeElement).toBe(node(tab('resources'))); expect(body.scrollTop).toBe(0)
  body.scrollTop = 80; await act(async () => body.dispatchEvent(new Event('scroll', { bubbles: true })))
  await act(async () => node(tab('resources')).dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  expect(document.activeElement).toBe(node(tab('overview'))); expect(body.scrollTop).toBe(120)
  await click(tab('resources')); expect(body.scrollTop).toBe(80)
  expect(document.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
  const selected = node('[role="tab"][aria-selected="true"]')
  expect(document.getElementById(selected.getAttribute('aria-controls')!)?.getAttribute('aria-labelledby')).toBe(selected.id)
})

it('keeps separate Host source times and does not use free memory to invent pressure', async () => {
  const value = snapshot(), source = value.observation!.diagnostics, host = source.data!.host
  host.pressure.observedAt! -= 120000; host.swap.observedAt! -= 60000
  await render(value)
  expect(node('[data-memory-pressure]').textContent).toBe('Warning')
  expect(node('.performance-host-sources').textContent).toContain('2m old')
  expect(node('.performance-host-sources').textContent).toContain('1m old')
  host.pressure = { observedAt: null, data: null, unavailable: 'Pressure is not supported on this source' }
  host.cpu.data!.percent = null; host.cpu.data!.intervalMs = null; host.cpu.data!.unavailable = 'Waiting for a valid interval'
  await render(value)
  expect(node('[data-memory-pressure]').textContent).toBe('Unavailable')
  expect(node('.performance-host-sources').textContent).toContain('Pressure is not supported')
  expect(node('.performance-host-load').textContent).not.toContain('23.5%')
  expect(node('[data-host-volume]').textContent).toContain('19.0 GiB')
})

it('reads one selected interface without summing duplicated VPN traffic or replacing a vanished identity', async () => {
  const value = snapshot(); await render(value)
  const select = node<HTMLSelectElement>('[aria-label="Network interface"]')
  expect(select.value).toBe(''); expect(node('.performance-network-rates').textContent).toBe('↓ Download—↑ Upload—')
  await act(async () => { select.value = JSON.stringify(['en0', 1]); select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(node('.performance-network-rates').textContent).toContain('2.0 KiB/s')
  expect(node('.performance-network-rates').textContent).not.toContain('4.0 KiB/s')
  const network = value.observation!.diagnostics.data!.host.network
  network.data!.interfaces = network.data!.interfaces.filter(item => item.name !== 'en0')
  await render(value)
  expect(node<HTMLSelectElement>('[aria-label="Network interface"]').value).toBe(JSON.stringify(['en0', 1]))
  expect(node('[data-host-network]').textContent).toContain('selected interface is missing')
  expect(node('.performance-network-rates').textContent).toBe('↓ Download—↑ Upload—')
  network.data!.interfaces.push({ name: 'en0', linkId: 3, receivedBytes: 1, sentBytes: 1, receiveBytesPerSecond: null, sendBytesPerSecond: null, intervalMs: null, unavailable: 'New interface interval' })
  await render(value)
  expect(node<HTMLSelectElement>('[aria-label="Network interface"]').value).toBe(JSON.stringify(['en0', 1]))
  await act(async () => { select.value = JSON.stringify(['en0', 3]); select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(node('[data-host-network]').textContent).toContain('New interface interval')
  expect(node('.performance-network-rates').textContent).toBe('↓ Download—↑ Upload—')
})

it('expands and compacts the same actual ToolkitPopover without replacing its local readers', async () => {
  const value = snapshot()
  function Tool() {
    const [selected, setSelected] = useState<string | symbol | null>('performance')
    return <ToolkitPopover toolId="performance" name="Performance" icon={null} selectedToolId={selected} onSelectTool={setSelected}>{close =>
      <PerformanceOverview snapshot={value} close={close} onConfigure={() => {}} onViewScript={() => {}} />}</ToolkitPopover>
  }
  await dom.render(<Tool />)
  const panel = node('.performance-popover'), input = node('[aria-label="Choose saved CPU profile"]'), capture = node('[data-performance-capture]')
  await click('[aria-label="Expand Performance"]'); expect(panel.dataset.performanceExpanded).toBe('true')
  await click(tab('artifacts')); await click('[aria-label="Compact Performance"]')
  expect(node('.performance-popover')).toBe(panel); expect(panel.dataset.performanceExpanded).toBe('false')
  expect(node('[aria-label="Choose saved CPU profile"]')).toBe(input); expect(node('[data-performance-capture]')).toBe(capture)
  await click('[aria-label="Close Performance"]'); expect(document.querySelector('.performance-popover')).toBeNull()
})

it('keeps the Run source age and incomplete coverage visible beside a fresh App summary', async () => {
  const value = snapshot(), observed = value.observation!, process = observed.process
  process.state = 'stale'; process.lastSuccessAt! -= 60000; process.observedAt! -= 60000
  process.reason = 'Original process source failed while App stayed fresh'
  observed.runTotals!.cpuPercent = 41.7; observed.runTotals!.rssKib = 1048576
  await render(value)
  const overview = node('[data-performance-section="overview"]')
  expect(observed.app.state).toBe('available')
  expect(overview.textContent).toContain('1m old')
  expect(overview.textContent).toContain('Previous reading')
  expect(overview.textContent).toContain('Original process source failed')
  expect(overview.textContent).toContain('missing roots; totals incomplete')
  expect(overview.textContent).toContain('18.4%')
  expect(node('.performance-overview-runs').textContent).toContain('41.7%')
  expect(node('.performance-overview-runs').textContent).toContain('1.0 GiB')
})


function prepareRuns() {
  const value = snapshot(), session = composerSession('client-reader')
  session.workspacePath = fixturePath('home/projects/repo')
  session.control = { ...session.control, agentSessionId: 'durable-reader', run: { runId: 'observed-reader' } }
  const run = value.observation!.process.data![0]!
  value.observation!.process.data = [{ ...run, hostId: 'local', runId: 'observed-reader', cpuPercent: 12.3 },
    { ...run, hostId: 'local', runId: 'unmapped-reader', cpuPercent: 4.3 }]
  delete value.document!.agentCards
  useAppStore.setState({ sessions: [session], config: { ...composerConfig, workspaces: [{ ...composerConfig.workspaces[0]!, path: session.workspacePath }] }, agentNames: { [session.id]: 'Atlas' }, localHome: fixturePath('home'),
    loading: false, tabs: {}, layouts: {}, activeWorkspaceId: 'workspace', mainSurface: 'workbench', closingWorkbenchViews: {},
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  return { value, session }
}

it('resolves visible Run identities without result cards and navigates through the original client Session action', async () => {
  const { value, session } = prepareRuns(), close = vi.fn()
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  await dom.render(<PerformanceOverview snapshot={value} close={close} onConfigure={() => {}} onViewScript={() => {}} />)
  await click(tab('resources')); await click('[data-settings-target="runs"]')
  const row = node('[data-run-id="observed-reader"]')
  expect(row.textContent).toContain('Atlas'); expect(row.textContent).toContain('Project')
  expect(row.querySelector('[data-card-field="workspace"]')?.textContent).toContain('~/projects/repo')
  expect(row.querySelector('[data-card-field="workspace"]')?.getAttribute('title')).toBe('~/projects/repo')
  const unmapped = node('[data-run-id="unmapped-reader"]')
  expect(unmapped.textContent).toContain('Agent identity unavailable'); expect(unmapped.textContent).toContain('4.3%')
  expect(unmapped.querySelector('[data-performance-open-run]')).toBeNull()
  await click('[data-run-id="observed-reader"] [data-performance-open-run]')
  expect(select).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(close).toHaveBeenCalledOnce()
  const state = useAppStore.getState()
  expect(state.agentFocus.execution.sessionId).toBe(session.id)
  expect(Object.values(state.tabs).some(tab => JSON.stringify(tab).includes(session.id))).toBe(true)
  expect(state.sessions).toEqual([session]); expect(state.sessions[0]!.control.run.runId).toBe('observed-reader')
})

it('retains the reading on a refused navigation and revalidates a stale Run at click time', async () => {
  const { value, session } = prepareRuns(), close = vi.fn()
  useAppStore.setState({ closingWorkbenchViews: { held: { workspaceId: 'workspace', tabGroupId: 'held-group', tabId: 'held', closesView: true,
    surfaces: [], resources: [], reservedSessionIds: [session.id] } } })
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  await dom.render(<PerformanceOverview snapshot={value} close={close} onConfigure={() => {}} onViewScript={() => {}} />)
  await click(tab('resources')); await click('[data-settings-target="runs"]')
  await click('[data-performance-open-run]')
  expect(select).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
  expect(node('[data-run-id="observed-reader"] [role="status"]').textContent).toContain('reading are kept')
  expect(node('[data-run-id="observed-reader"]').textContent).toContain('12.3%')
  const button = node<HTMLButtonElement>('[data-performance-open-run]')
  await act(async () => {
    useAppStore.setState({ closingWorkbenchViews: {}, sessions: [{ ...session, control: { ...session.control, run: { runId: 'replacement-reader' } } }] })
    expect(button.isConnected).toBe(true); button.click()
  })
  expect(select).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
  expect(node('[data-run-id="observed-reader"] [role="status"]').textContent).toContain('identity unavailable')
  expect(node('[data-run-id="observed-reader"]').textContent).toContain('12.3%')
  expect(useAppStore.getState().tabs).toEqual({})
})
