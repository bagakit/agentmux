// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxBrowserTarget, AgentMuxBrowserTargetsResult } from '@agentmux/core'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'

const wire = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null,
  invoke: vi.fn(), listeners: new Map<string, Set<(...args: unknown[]) => void>>() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld(_key: string, value: AgentMuxPreloadApi) { wire.api = value } },
  ipcRenderer: { invoke: wire.invoke, on(channel: string, listener: (...args: unknown[]) => void) {
    const listeners = wire.listeners.get(channel) ?? new Set(); listeners.add(listener); wire.listeners.set(channel, listeners)
  }, off(channel: string, listener: (...args: unknown[]) => void) { wire.listeners.get(channel)?.delete(listener) },
  removeListener(channel: string, listener: (...args: unknown[]) => void) { wire.listeners.get(channel)?.delete(listener) }, send: vi.fn() }, webFrame: {} }))
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { composerConfig } from './helpers/composer-dom-fixture'
import { MobileRegionContent } from '../../mobile/src/navigation/MobileRegionContent'
import { parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets'
import { TOOLKIT_CHANGED_CHANNEL } from '../src/shared/toolkit'
import { performanceAttributionSnapshots } from '../scripts/fixtures/performance-panel/data'

// Controlled wire material exercises real Settings/Store/API/preload consumers; no machine measurement or native page.
const target = (id: string, workspaceId = 'workspace'): AgentMuxBrowserTarget & { navigationId: string } => ({ id, workspaceId,
  source: 'external', status: 'ready', url: `https://${id}.example/`, title: `Original ${id}`,
  navigationId: `navigation-${id}`, capabilities: ['snapshot'] })
const result = (ids: string[], coverage: AgentMuxBrowserTargetsResult['coverage'] = 'complete'): AgentMuxBrowserTargetsResult => ({ targets: ids.map(id => target(id)), coverage })
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no }), resolve, reject } }
let root: Root, container: HTMLDivElement, initial: ReturnType<typeof useAppStore.getState>
let read: ReturnType<typeof vi.fn>, current: AgentMuxBrowserTargetsResult
let uploadRead: ReturnType<typeof vi.fn>
let release: ReturnType<typeof vi.fn>, restore: ReturnType<typeof vi.fn>
let saveConfig: ReturnType<typeof vi.fn>
let metricSnapshot = performanceAttributionSnapshots.fresh
const metricIds = new Set<string>()
const listenerSet = () => wire.listeners.get('browser:targetsChanged') ?? new Set()
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
const section = () => container.querySelector<HTMLElement>('.external-browser-connections')!
const text = () => container.textContent ?? ''
const render = async (visible: boolean) => { await act(async () => root.render(<SettingsPanel visible={visible} initialSection="browser" onClose={() => {}} />)); await settle() }
const change = async () => { await act(async () => { for (const listener of [...listenerSet()]) listener() }); await settle() }
const click = async (name: string) => { const button = [...section().querySelectorAll('button')].find(button => button.textContent?.trim() === name)
  expect(button).toBeDefined(); await act(async () => button!.click()); await settle() }
const resources = () => container.querySelector<HTMLElement>('.browser-resources')!
const row = (id: string) => container.querySelector<HTMLElement>(`[data-browser-resource="${id}"]`)!
const resourceClick = async (name: string, id?: string) => { const button = [...(id ? row(id) : resources()).querySelectorAll('button')].find(button => button.textContent?.trim() === name)
  expect(button).toBeDefined(); await act(async () => button!.click()); await settle() }
const embedded = (id: string, state: 'live' | 'released' | 'cold' = 'live'): AgentMuxBrowserTarget => {
  const { navigationId, ...page } = target(id)
  return { ...page, source: 'embedded', mode: 'normal',
    ...(state === 'live' ? { navigationId } : { status: 'unavailable', capabilities: [] }),
    resource: { state, locations: [{ workspaceId: 'workspace', tabId: `tab-${id}`, regionId: `region-${id}` }],
      processes: state === 'live' ? [{ pid: 77, creationTime: 100 }] : [], ...(state === 'live' ? { retention: { status: 'eligible', reasons: [] } } : {}) } }
}
beforeEach(async () => {
  expect(homedir()).toBe(process.env.AGENTMUX_DIRECTORY_PRIVATE_HOME)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  initial = useAppStore.getState(); useAppStore.setState({ config: composerConfig, activeWorkspaceId: 'workspace' })
  current = result(['a', 'b']); read = vi.fn(async () => current); wire.listeners.clear(); metricIds.clear()
  uploadRead = vi.fn(async () => ({ selections: [] }))
  metricSnapshot = structuredClone(performanceAttributionSnapshots.fresh)
  release = vi.fn(async (id: string, navigationId: string) => ({ browserId: id, navigationId, status: 'released', reasons: [] }))
  restore = vi.fn(async (id: string) => { const { resource: _resource, ...restored } = embedded(id); return restored })
  saveConfig = vi.fn(async (next: AppConfig) => next)
  wire.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'browser:listTargets') return await read(args[0])
    if (channel === 'toolkit:observe') { const id = args[1] as string; metricIds.add(id)
      for (const listener of wire.listeners.get(TOOLKIT_CHANGED_CHANNEL) ?? []) listener({}, { id, snapshot: metricSnapshot })
      return
    }
    if (channel === 'toolkit:release') { metricIds.delete(args[0] as string); return }
    if (channel === 'browser:release') return await release(...args)
    if (channel === 'browser:restoreResource') return await restore(...args)
    if (channel === 'config:save') return await saveConfig(...args)
    if (channel === 'browser:listRetainedUploads') return await uploadRead()
    if (channel === 'browser:createExternalPairing') return { link: 'ws://private-pairing.invalid/#original', expiresAt: Date.now() + 600000 }
    throw new Error(`Unexpected fixture IPC ${channel}`)
  })
  vi.spyOn(api.browser, 'listTargets').mockImplementation(id => wire.api!.browser.listTargets(id))
  vi.spyOn(api.browser, 'onTargetsChanged').mockImplementation(listener => wire.api!.browser.onTargetsChanged(listener))
  vi.spyOn(api.browser, 'listRetainedUploads').mockImplementation(() => wire.api!.browser.listRetainedUploads())
  vi.spyOn(api.browser, 'createExternalPairing').mockImplementation(id => wire.api!.browser.createExternalPairing(id))
  vi.spyOn(api.browser, 'release').mockImplementation((id, navigationId) => wire.api!.browser.release(id, navigationId))
  vi.spyOn(api.browser, 'restoreResource').mockImplementation(id => wire.api!.browser.restoreResource(id))
  vi.spyOn(api.toolkit, 'observe').mockImplementation((...args) => wire.api!.toolkit.observe(...args))
  vi.spyOn(api.config, 'save').mockImplementation((...args) => wire.api!.config.save(...args))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); wire.invoke.mockReset(); expect(listenerSet().size).toBe(0); expect(metricIds.size).toBe(0) })

it('keeps prior external rows on partial/failure and removes only after a complete current query', async () => {
  await render(true); expect(read).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(text()).toContain('Original b'); expect(text()).toContain('2 ready in latest query')
  current = result(['a'], 'partial'); await change()
  expect(text()).toContain('Original b'); expect(text()).toContain('Previously observed')
  expect(text()).toContain('1 ready in latest query'); expect(text()).toContain('This query is partial')
  read.mockRejectedValueOnce(new Error('Original membership unavailable')); await change()
  expect(text()).toContain('Original b'); expect(text()).toContain('Original membership unavailable')
  current = result(['a']); await change(); expect(text()).not.toContain('Original b')
})

it('coalesces change bursts into one in-flight read and one fresh cut without blocking a new visible generation', async () => {
  current = result(['a']); await render(true)
  const older = deferred<AgentMuxBrowserTargetsResult>(), newer = deferred<AgentMuxBrowserTargetsResult>()
  read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  await change()
  for (let i = 0; i < 20; i++) await change()
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => older.resolve(result(['a', 'first-point'], 'partial'))); await settle()
  expect(read).toHaveBeenCalledTimes(3); expect(text()).toContain('Original first-point')
  // Another burst arrives during every point read. Publishing must not wait for global quiet.
  const continuing = deferred<AgentMuxBrowserTargetsResult>()
  read.mockReturnValueOnce(continuing.promise)
  for (let i = 0; i < 20; i++) await change()
  expect(read).toHaveBeenCalledTimes(3)
  await act(async () => newer.resolve(result(['a', 'b'], 'partial'))); await settle()
  expect(read).toHaveBeenCalledTimes(4)
  expect(text()).toContain('Original b'); expect(text()).toContain('This query is partial')
  await act(async () => continuing.resolve(result(['a', 'b'], 'partial'))); await settle()
  const olderError = deferred<AgentMuxBrowserTargetsResult>(), newest = deferred<AgentMuxBrowserTargetsResult>()
  read.mockReturnValueOnce(olderError.promise).mockReturnValueOnce(newest.promise)
  await change(); await change(); expect(read).toHaveBeenCalledTimes(5)
  await act(async () => olderError.reject(new Error('Superseded read error'))); await settle()
  expect(read).toHaveBeenCalledTimes(6)
  expect(text()).toContain('Superseded read error'); expect(text()).toContain('Original b')
  await act(async () => newest.resolve(result(['a', 'b'], 'partial'))); await settle()
  expect(text()).not.toContain('Superseded read error'); expect(text()).toContain('Original b')
  const hiddenRead = deferred<AgentMuxBrowserTargetsResult>()
  read.mockReturnValueOnce(hiddenRead.promise); await change(); await change()
  expect(read).toHaveBeenCalledTimes(7)
  await render(false); current = result(['c']); await render(true)
  expect(read).toHaveBeenCalledTimes(8); expect(text()).toContain('Original c')
  await act(async () => hiddenRead.resolve(result([]))); await settle()
  expect(read).toHaveBeenCalledTimes(8); expect(text()).toContain('Original c')
})

it('scopes the real retained Settings observer to active visibility and preserves catalog pairing and automation draft', async () => {
  await render(false); expect(read).not.toHaveBeenCalled()
  expect(listenerSet().size).toBe(0); expect(uploadRead).not.toHaveBeenCalled()
  await change(); expect(read).not.toHaveBeenCalled(); expect(uploadRead).not.toHaveBeenCalled()
  await render(true); expect(read).toHaveBeenCalledTimes(1)
  expect(metricIds.size).toBe(1); expect(uploadRead).toHaveBeenCalledTimes(1)
  const activeListeners = [...listenerSet()]; expect(activeListeners).toHaveLength(2)
  await click('Connect extension');
  const automation = container.querySelector<HTMLInputElement>('[data-settings-field="agent-automation"] input')!
  await act(async () => automation.click()); expect(automation.checked).toBe(true)
  const pairing = () => container.querySelector<HTMLInputElement>('[aria-label="Private extension connection link"]')?.value
  expect(pairing()).toBe('ws://private-pairing.invalid/#original')
  const pending = deferred<AgentMuxBrowserTargetsResult>(); read.mockReturnValueOnce(pending.promise)
  const oldUpload = deferred<{ selections: [] }>(); uploadRead.mockReturnValueOnce(oldUpload.promise)
  await change()
  const count = read.mock.calls.length
  const uploadCount = uploadRead.mock.calls.length
  await render(false); expect(activeListeners.every(listener => !listenerSet().has(listener))).toBe(true)
  expect(metricIds.size).toBe(0)
  expect(listenerSet().size).toBe(0); await change(); expect(read).toHaveBeenCalledTimes(count)
  expect(uploadRead).toHaveBeenCalledTimes(uploadCount)
  await act(async () => pending.resolve(result([]))); await settle()
  expect(text()).toContain('Original b'); expect(pairing()).toBe('ws://private-pairing.invalid/#original'); expect(automation.checked).toBe(true)
  current = result(['c']); await render(true); expect(read).toHaveBeenCalledTimes(count + 1)
  expect(uploadRead).toHaveBeenCalledTimes(uploadCount + 1); expect(listenerSet().size).toBe(2)
  await act(async () => oldUpload.reject(new Error('Retired upload observation'))); await settle()
  expect(text()).not.toContain('Retired upload observation')
  expect(text()).toContain('Original c'); expect(text()).not.toContain('Original b')
  expect(pairing()).toBe('ws://private-pairing.invalid/#original'); expect(automation.checked).toBe(true)
})

it('shares one all-Workspace directory and preserves partial positions while deduplicating exact process births', async () => {
  const a = embedded('a'), b = embedded('b'), reused = embedded('reused')
  a.resource!.locations = Array.from({ length: 257 }, (_, i) => ({ workspaceId: 'workspace', tabId: 'tab-a', regionId: `original-position-${i}` }))
  reused.resource!.processes = [{ pid: 77, creationTime: 101 }]
  current = { targets: [a, b, reused, target('other-workspace', 'other')], coverage: 'complete' }
  const observed = metricSnapshot.observation
  assert.ok(observed, 'The controlled fresh input must contain its actual observation.')
  const originalApp = observed.app.data
  assert.ok(originalApp, 'The controlled fresh input must contain its actual App reading.')
  observed.app = { state: 'stale', observedAt: _tailFixtureEpoch(0, 0, 10), lastSuccessAt: _tailFixtureEpoch(0, 0, 10), reason: 'Prior App reading',
    data: { ...originalApp, processes: [{ pid: 77, creationTime: 100, role: 'browser', type: 'Tab', cpuPercent: 4, intervalMs: 1000, rssKib: 131072 }], omittedProcesses: 2 } }
  await render(true)
  expect(read).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(section().textContent).toContain('Original other-workspace')
  expect(resources().querySelector('[data-browser-process-total]')?.textContent).toContain('128 MiB1 unique processes')
  expect(resources().textContent).toContain('1 unmatched process identities')
  expect(resources().textContent).toContain('2 App processes omitted')
  expect(row('a').textContent).toContain('original-position-256'); expect(row('a').textContent).toContain('shared')
  expect(row('reused').textContent).toContain('No matching process reading')
  const partial = embedded('a'); partial.resource!.locations = []; partial.resource!.processes = null
  current = { targets: [partial], coverage: 'partial' }; await change()
  expect(row('a').textContent).toContain('Previous positions'); expect(row('a').textContent).toContain('original-position-256')
  expect(row('a').textContent).toContain('Process ownership unconfirmed')
  expect(row('b').textContent).toContain('Previously observed')
  expect(resources().querySelector('[data-browser-process-total]')?.textContent).not.toContain('128 MiB')
  current = { targets: [{ ...partial, resource: { ...partial.resource!, locations: [] } }], coverage: 'complete' }; await change()
  expect(row('a').textContent).not.toContain('original-position-256'); expect(container.querySelector('[data-browser-resource="b"]')).toBeNull()
  metricSnapshot = { ...metricSnapshot, observation: null }
  await act(async () => { for (const id of metricIds) for (const listener of wire.listeners.get(TOOLKIT_CHANGED_CHANNEL) ?? []) listener({}, { id, snapshot: metricSnapshot }) }); await settle()
  expect(resources().querySelector('[data-browser-process-total]')?.textContent).toContain('Reading not confirmed')
})

it('dispatches one finite release batch serially through preload and keeps each original mixed receipt without retry', async () => {
  current = { targets: ['a', 'b', 'c'].map(id => embedded(id)), coverage: 'complete' }
  await render(true)
  const first = deferred<{ browserId: string; navigationId: string; status: string; reasons: string[] }>()
  release.mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(async (browserId: string, navigationId: string) => ({ browserId, navigationId, status: 'retained', reasons: ['document-used'] }))
    .mockImplementationOnce(async (browserId: string, navigationId: string) => ({ browserId, navigationId, status: 'unknown', reasons: ['document-unconfirmed'] }))
  await act(async () => resources().querySelector<HTMLInputElement>('[aria-label="Select eligible pages in this filter"]')!.click()); await settle()
  await resourceClick('Release selected (3)')
  expect(release.mock.calls).toEqual([['a', 'navigation-a']])
  await resourceClick('Releasing…', 'a'); expect(release).toHaveBeenCalledTimes(1)
  const after = { ...embedded('a'), navigationId: 'later-document' }
  current = { targets: [after, embedded('b'), embedded('c')], coverage: 'complete' }; await change()
  await act(async () => first.resolve({ browserId: 'a', navigationId: 'navigation-a', status: 'released', reasons: [] })); await settle()
  expect(release.mock.calls).toEqual([['a', 'navigation-a'], ['b', 'navigation-b'], ['c', 'navigation-c']])
  expect(row('a').textContent).toContain('Previous document · Released')
  expect(row('b').querySelector('[data-result="retained"]')?.textContent).toContain('Kept')
  expect(row('c').textContent).toContain('Protection unconfirmed')
  await change(); await render(false); await render(true)
  expect(release).toHaveBeenCalledTimes(3)
  // Main can return unknown before dispatching close. Later authority may confirm the same document eligible.
  expect(current.targets.find(target => target.id === 'c')?.navigationId).toBe('navigation-c')
  expect(current.targets.find(target => target.id === 'c')?.resource?.retention?.status).toBe('eligible')
  expect(row('c').querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
  expect([...resources().querySelectorAll('button')].find(button => button.textContent === 'Release selected (3)')?.disabled).toBe(false)
  release.mockResolvedValueOnce({ browserId: 'c', navigationId: 'navigation-c', status: 'unknown', reasons: [] })
  await resourceClick('Release memory', 'c')
  expect(release).toHaveBeenCalledTimes(4); expect(release).toHaveBeenLastCalledWith('c', 'navigation-c')
  expect(row('c').textContent).toContain('Unconfirmed · Release outcome unconfirmed; original identity kept.')
  expect(row('c').textContent).not.toContain('Native page released')
  release.mockResolvedValueOnce({ browserId: 'c', navigationId: 'navigation-c', status: 'retained', reasons: [] })
  await resourceClick('Release memory', 'c')
  expect(release).toHaveBeenCalledTimes(5)
  expect(row('c').textContent).toContain('Kept · Release not applied; original identity kept.')
  expect(row('c').textContent).not.toContain('Native page released')
  expect(restore).not.toHaveBeenCalled()
})

it('keeps the selected original document when refresh, filtering and new pages change the visible directory', async () => {
  current = { targets: [embedded('a'), embedded('b')], coverage: 'complete' }; await render(true)
  await act(async () => row('a').querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await settle()
  current = { targets: [{ ...embedded('a'), navigationId: 'new-document-a' }, embedded('b'), embedded('later')], coverage: 'complete' }
  await change()
  const search = resources().querySelector<HTMLInputElement>('[aria-label="Find Browser resources"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Original b'); search.dispatchEvent(new Event('input', { bubbles: true })) }); await settle()
  expect(resources().textContent).toContain('1 selected · includes pages outside this filter')
  await resourceClick('Release selected (1)')
  expect(release.mock.calls).toEqual([['a', 'navigation-a']])
  expect(restore).not.toHaveBeenCalled()
})

it('keeps explicit comparison order and keyboard target while original process readings update', async () => {
  const a = embedded('a'), b = embedded('b')
  b.resource!.processes = [{ pid: 78, creationTime: 100 }]
  current = { targets: [a, b], coverage: 'complete' }
  const data = metricSnapshot.observation!.app.data!
  data.processes = [{ pid: 77, creationTime: 100, role: 'browser', type: 'Tab', cpuPercent: 0, intervalMs: 1000, rssKib: 0 },
    { pid: 78, creationTime: 100, role: 'browser', type: 'Tab', cpuPercent: null, intervalMs: null, rssKib: 2048 }]
  await render(true); await resourceClick('Process memory')
  expect([...resources().querySelectorAll('[data-browser-resource]')].map(item => item.getAttribute('data-browser-resource'))).toEqual(['b', 'a'])
  expect(row('a').querySelector('.browser-resources__memory')?.textContent).toContain('0 MiB')
  const originalButton = row('b').querySelector<HTMLButtonElement>('button')!; originalButton.focus()
  data.processes[0]!.rssKib = 999999
  await act(async () => { for (const id of metricIds) for (const listener of wire.listeners.get(TOOLKIT_CHANGED_CHANNEL) ?? []) listener({}, { id, snapshot: structuredClone(metricSnapshot) }) }); await settle()
  expect([...resources().querySelectorAll('[data-browser-resource]')].map(item => item.getAttribute('data-browser-resource'))).toEqual(['b', 'a'])
  expect(document.activeElement).toBe(originalButton)
  expect(release).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
})

it('restores a known identity without catalog fanout or treating missing resource as fresh released/process facts', async () => {
  current = { targets: [embedded('cold', 'released')], coverage: 'complete' }; await render(true)
  const older = deferred<AgentMuxBrowserTargetsResult>()
  read.mockReturnValueOnce(older.promise); await change(); const reads = read.mock.calls.length
  await resourceClick('Restore', 'cold')
  expect(restore).toHaveBeenCalledExactlyOnceWith('cold', undefined)
  expect(wire.invoke).toHaveBeenCalledWith('browser:restoreResource', 'cold', undefined)
  expect(read).toHaveBeenCalledTimes(reads)
  expect(row('cold').textContent).toContain('Restored · Original native page ready')
  expect(row('cold').textContent).toContain('Previously observed')
  await act(async () => older.resolve(current)); await settle()
  expect(row('cold').textContent).toContain('Previously observed')
  current = { targets: [embedded('cold')], coverage: 'complete' }; await change()
  expect(row('cold').textContent).toContain('Running'); expect(row('cold').textContent).not.toContain('Previously observed')
})

it('keeps a wrong-source release receipt unknown and leaves the original workbench untouched', async () => {
  current = { targets: [embedded('a'), embedded('healthy')], coverage: 'complete' }; await render(true)
  const before = useAppStore.getState(), positions = { tabs: before.tabs, layouts: before.layouts, activeWorkspaceId: before.activeWorkspaceId }
  release.mockResolvedValueOnce({ browserId: 'foreign', navigationId: 'navigation-a', status: 'released', reasons: [] })
  await resourceClick('Release memory', 'a')
  expect(release).toHaveBeenCalledExactlyOnceWith('a', 'navigation-a')
  expect(row('a').textContent).toContain('Unconfirmed · Release did not confirm this original document')
  expect(row('a').textContent).not.toContain('Native page released')
  expect(useAppStore.getState()).toMatchObject(positions)
  await change(); expect(release).toHaveBeenCalledTimes(1)
  read.mockRejectedValueOnce(new Error('Saved directory unavailable')); await change()
  await resourceClick('Release memory', 'healthy')
  expect(release).toHaveBeenLastCalledWith('healthy', 'navigation-healthy')
  expect(row('healthy').textContent).toContain('Released · Native page released')
})

it('saves both Browser fields through the module and preload with original expected values while keeping a later edit', async () => {
  await render(true)
  const automation = container.querySelector<HTMLInputElement>('[data-settings-field="agent-automation"] input')!
  const automatic = container.querySelector<HTMLInputElement>('[data-settings-field="automatic-memory-release"] input')!
  expect(automatic.checked).toBe(true)
  await act(async () => { automation.click(); automatic.click() }); await settle()
  const saving = deferred<AppConfig>(); saveConfig.mockReturnValueOnce(saving.promise)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.click()); await settle()
  expect(saveConfig).toHaveBeenCalledTimes(1)
  const [next, expected] = saveConfig.mock.calls[0] as [AppConfig, AppConfig]
  expect(next.browser).toMatchObject({ agentAutomation: true, automaticMemoryRelease: false })
  expect(expected.browser).toMatchObject({ agentAutomation: false, automaticMemoryRelease: true })
  await act(async () => automatic.click()); expect(automatic.checked).toBe(true)
  await act(async () => { useAppStore.setState({ config: next }); saving.resolve(next) }); await settle()
  expect(automatic.checked).toBe(true)
  expect(container.querySelector('[data-settings-save-bar] [role="status"]')?.textContent).toBe('Unsaved changes')
  expect(release).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
})

it('keeps the exact Mobile Browser reader when a strict partial result omits that original id', async () => {
  let material = result(['b', 'a'])
  const forwardRpc = vi.fn(async (method: string) => { expect(method).toBe('browser.targets'); return parseBrowserTargetsResult(material) })
  const client = { forwardRpc } as never
  await act(async () => root.render(<MobileRegionContent client={client} kind="browser" browserId="a" tabId="original-tab" regionId="original-region" zoneId={null} />)); await settle()
  expect(container.querySelector('a')?.href).toBe('https://a.example/')
  material = result(['b'], 'partial')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click()); await settle()
  expect(container.querySelector('a')?.href).toBe('https://a.example/')
  expect(container.textContent).toContain('原 browserId 的当前网址尚未唯一确认')
  expect(container.textContent).not.toContain('https://b.example/')
  expect(forwardRpc).toHaveBeenCalledTimes(2)
})
