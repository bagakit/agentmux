// @vitest-environment happy-dom
import { act } from 'react'
import { createClientUiRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { performanceSnapshot } from '../scripts/fixtures/performance-panel/data'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import type { ToolkitSnapshot } from '../src/shared/toolkit'

let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, initial: ReturnType<typeof useAppStore.getState>
let snapshot = structuredClone(performanceSnapshot), publish: (value: ToolkitSnapshot) => void
let release: ReturnType<typeof vi.fn>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  initial = useAppStore.getState(); snapshot = structuredClone(performanceSnapshot)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  release = vi.fn(); publish = () => {}
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_toolId, listener) => { publish = listener; listener(snapshot); return { dispose: release } })
  vi.spyOn(api.toolkit, 'run'); vi.spyOn(api.toolkit, 'stop'); vi.spyOn(api.config, 'save')
  useAppStore.setState({ ...initial, config: { ...composerConfig, toolkit: { performance: { enabled: true, statusBar: 'label' } } },
    loading: false, initialize: async () => () => {}, detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}),
    sessions: [composerSession('sample-reader')], hostChecks: {}, error: null, tabs: {}, layouts: {},
    mainSurface: 'workbench', toolsOpen: false, providerCatalog: await api.providers.list() }, true)
  await act(async () => root.render(<App />)); await click('.performance-trigger')
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function node<T extends Element = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector)
  expect(value, `Original product node is present: ${selector}`).not.toBeNull(); expect(value!.isConnected).toBe(true)
  return value!
}
const chart = (label = 'CPU') => node<SVGSVGElement>(`[aria-label="${label} history"]`)
const detail = (label = 'CPU') => node(`[aria-label="${label} history"]`).parentElement!.querySelector<HTMLElement>('.performance-trend-detail')!
async function click(selector: string) { await act(async () => node<HTMLButtonElement>(selector).click()) }
async function key(key: string, label = 'CPU', composing = false) {
  const target = chart(label); let event!: KeyboardEvent
  await act(async () => { target.focus(); event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: composing }); target.dispatchEvent(event) })
  return event
}
async function update(change: (value: typeof snapshot) => void) {
  snapshot = structuredClone(snapshot); change(snapshot); await act(async () => publish(snapshot))
}
function append(value: typeof snapshot, count = 1) {
  for (let index = 0; index < count; index++) {
    const at = value.trend.at(-1)!.observedAt + 1000
    value.observedAt = at; value.observation!.observedAt = at
    value.observation!.app.observedAt = at; value.observation!.app.lastSuccessAt = at
    value.trend.push({ observedAt: at, appCpuPercent: 39.12345 + index, appRssKib: 654321 + index })
  }
  value.trend = value.trend.slice(-60)
}

it('reads exact retained values, units and original sample time through App → Toolkit without a new lease or action', async () => {
  const first = snapshot.trend[0]!
  await key('Home')
  expect(detail().querySelector('span')!.textContent).toBe(`${first.appCpuPercent}%`)
  expect(detail().textContent).toContain(new Date(first.observedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }))
  expect(detail().dataset.sampleState).toBe('selected')
  await key('Home', 'Resident memory')
  expect(detail('Resident memory').querySelector('span')!.textContent).toBe(`${first.appRssKib} KiB`)
  expect(node('.performance-body').textContent).toContain('10s reading peak')
  await act(async () => useAppStore.setState({ sessions: [...useAppStore.getState().sessions, composerSession('unrelated')] }))
  expect(detail('Resident memory').dataset.sampleState).toBe('selected')
  expect(api.toolkit.observe).toHaveBeenCalledTimes(1); expect(api.toolkit.run).not.toHaveBeenCalled(); expect(api.toolkit.stop).not.toHaveBeenCalled(); expect(api.config.save).not.toHaveBeenCalled()
})

it('keeps an explicit sample across incoming points and reports eviction instead of silently following the latest', async () => {
  await key('Home'); const original = chart(), text = detail().textContent
  await update(value => append(value))
  expect(chart()).toBe(original); expect(detail().textContent).toBe(text)
  await act(async () => chart().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 100, pointerType: 'mouse' })))
  expect(detail().textContent).toBe(text)
  await update(value => append(value, 61))
  expect(detail().dataset.sampleState).toBe('expired'); expect(detail().textContent).toContain('Left retained history')
  expect(detail().textContent).not.toContain('39.12345%')
  await key('End')
  expect(detail().querySelector('span')!.textContent).toBe(`${snapshot.trend.at(-1)!.appCpuPercent}%`)
  expect(detail().dataset.sampleState).toBe('selected')
})

it('resets local selection on execution, official HostRun and observed Host changes, including A → B → A', async () => {
  const original = structuredClone(snapshot)
  for (const change of [
    (value: typeof snapshot) => { value.executionId += '-other' },
    (value: typeof snapshot) => { value.run = { ...value.run!, runId: 'other-official-run' } },
    (value: typeof snapshot) => { value.run = { ...value.run!, hostId: 'other-official-host' } },
    (value: typeof snapshot) => { value.observation!.scope.hostId = 'other-observed-host' }
  ]) {
    await key('Home'); const old = chart()
    await update(change)
    expect(chart()).not.toBe(old); expect(detail().dataset.sampleState).toBe('idle')
    snapshot = structuredClone(original); await act(async () => publish(snapshot))
    expect(detail().dataset.sampleState).toBe('idle')
  }
})

it('exposes original null samples without zero filling or joining the source gap; Pause/Resume preserves selected identity', async () => {
  const at = snapshot.trend.at(-1)!.observedAt
  await update(value => { value.trend.push({ observedAt: at + 1000, appCpuPercent: null, appRssKib: null }); value.trend.push({ observedAt: at + 2000, appCpuPercent: 12.3456, appRssKib: 765432 }) })
  await key('End'); await key('ArrowLeft')
  expect(detail().querySelector('span')!.textContent).toBe('Unavailable')
  const path = chart().querySelector<SVGPathElement>('path:last-of-type')!.getAttribute('d')!
  expect(path.match(/M/g)).toHaveLength(2)
  await key('Home'); const selected = detail().textContent
  await click('[data-performance-observation-toggle]')
  expect(release).toHaveBeenCalledTimes(1); expect(detail().textContent).toBe(selected)
  await click('[data-performance-observation-toggle]')
  expect(api.toolkit.observe).toHaveBeenCalledTimes(2); expect(detail().textContent).toBe(selected)
  expect(api.toolkit.stop).not.toHaveBeenCalled()
})

it('lets the focused chart consume one Escape, leaves IME untouched, then closes through its original floating owner', async () => {
  await key('Home')
  const composing = await key('Escape', 'CPU', true)
  expect(composing.defaultPrevented).toBe(false); expect(detail().dataset.sampleState).toBe('selected')
  const first = await key('Escape')
  expect(first.defaultPrevented).toBe(true); expect(detail().dataset.sampleState).toBe('idle')
  expect(node('.performance-popover')).toBeTruthy()
  const second = await key('Escape')
  expect(second.defaultPrevented).toBe(true); expect(document.querySelector('.performance-popover')).toBeNull()
  expect(release).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(node('.performance-trigger'))
})

it('reads selected Run samples from that exact HostRun and resets when selecting another Run', async () => {
  await click('[data-settings-target="runs"]')
  const firstRun = snapshot.observation!.process.data![0]!
  const row = node<HTMLDetailsElement>(`[data-run-id="${firstRun.runId}"]`)
  await act(async () => { row.open = true; row.dispatchEvent(new Event('toggle')) })
  await key('Home', 'Selected CPU')
  expect(detail('Selected CPU').querySelector('span')!.textContent).toBe(`${firstRun.cpuPercent}%`)
  const selected = detail('Selected CPU').textContent
  await update(value => { value.observedAt! += 1000; value.observation!.observedAt += 1000; value.observation!.process.observedAt! += 1000; value.observation!.process.lastSuccessAt! += 1000; value.observation!.process.data![0]!.cpuPercent = 14.4321 })
  expect(detail('Selected CPU').textContent).toBe(selected)
  const nextRun = snapshot.observation!.process.data![1]!
  const other = node<HTMLDetailsElement>(`[data-run-id="${nextRun.runId}"]`)
  await act(async () => { other.open = true; other.dispatchEvent(new Event('toggle')) })
  expect(detail('Selected CPU').dataset.sampleState).toBe('idle')
  await key('End', 'Selected resident memory')
  expect(detail('Selected resident memory').querySelector('span')!.textContent).toBe(`${nextRun.rssKib} KiB`)
})

it('releases the original hidden consumer and discards its local sample selection before reopening', async () => {
  await key('Home'); const original = chart()
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(document.querySelector('[aria-label="CPU history"]')).toBeNull()
  expect(release).toHaveBeenCalledTimes(1)
  hidden.mockReturnValue(false)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(chart()).not.toBe(original); expect(detail().dataset.sampleState).toBe('idle')
  expect(api.toolkit.observe).toHaveBeenCalledTimes(2)
  expect(api.toolkit.run).not.toHaveBeenCalled(); expect(api.toolkit.stop).not.toHaveBeenCalled()
})

it('returns keyboard Clear focus to the same original chart, then lets Escape close and restore the Toolkit trigger', async () => {
  await key('Home'); const original = chart()
  const clear = node<HTMLButtonElement>('[aria-label="Clear CPU sample selection"]')
  await act(async () => { clear.focus(); clear.click() })
  expect(clear.isConnected).toBe(false)
  expect(chart()).toBe(original); expect(document.activeElement).toBe(original)
  expect(detail().dataset.sampleState).toBe('idle')
  await key('Escape')
  expect(document.querySelector('.performance-popover')).toBeNull()
  expect(document.activeElement).toBe(node('.performance-trigger'))
  expect(release).toHaveBeenCalledTimes(1)
})
