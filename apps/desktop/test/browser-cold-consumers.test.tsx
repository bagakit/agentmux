// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { hydratePersistedTab, reducePersistedTab, type PersistedWorkbenchTab } from '../src/renderer/src/lib/workbench-persistence'
import type { AppConfig, BrowserSnapshot } from '../src/shared/contracts'
import { desktopWorkbenchObservationSchema } from '../src/shared/client-observation'

const original = useAppStore.getState()
let root: Root, host: HTMLDivElement, dispose: (() => void) | undefined
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {},
  workspaces: [{ id: 'workspace', name: 'Private fixture', hostId: 'local', path: fixturePath('private/cold-browser'), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const page: BrowserSnapshot = { id: 'page', mode: 'normal', navigationId: 'actual-navigation', profileId: 'saved-profile', viewport: 'tablet',
  url: 'https://fixture.invalid/original', title: 'Original page', loading: false, canGoBack: false, canGoForward: false,
  error: null, driving: false, appLinkPrompt: null }
function savedTab(id = 'page') {
  return createWorkbenchTab('tab-' + id, { ...page, id, browserId: id, kind: 'browser', regionId: 'region-' + id, workspaceId: 'workspace' })
}
function coldSurface(): BrowserWorkbenchSurface { return hydratePersistedTab(reducePersistedTab(savedTab())).regions['region-page'] as BrowserWorkbenchSurface }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...original, config, toolsOpen: false }, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue({ catalog: [], warnings: [] } as never)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); dispose?.(); dispose = undefined
  useAppStore.setState(original, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function address() { const value = host.querySelector<HTMLInputElement>('input[aria-label="Browser address"]'); expect(value).not.toBeNull(); return value! }
async function fill(text: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address(), text); address().dispatchEvent(new Event('input', { bubbles: true })) })
}

it('restores thirty exact Browser descriptions and layout before creating any native page', async () => {
  const tabs = Object.fromEntries(Array.from({ length: 30 }, (_, i) => { const tab = savedTab('page-' + i); return [tab.id, reducePersistedTab(tab)] }))
  const layout = createWorkspaceLayout('saved-group', Object.keys(tabs))
  useAppStore.setState({ loading: true, tabs: {}, layouts: {}, activeWorkspaceId: 'workspace',
    restoredWorkbench: { tabs, layouts: { workspace: layout } } })
  const create = vi.spyOn(api.browser, 'create'), restore = vi.spyOn(api.browser, 'restore')
  dispose = await useAppStore.getState().initialize()
  const current = useAppStore.getState()
  expect(create).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
  expect(Object.keys(current.tabs)).toEqual(Object.keys(tabs)); expect(current.layouts.workspace).toEqual(layout)
  expect(current.tabs['tab-page-9']!.regions['region-page-9']).toMatchObject({ browserId: 'page-9', nativeOwnerDeferred: true, viewport: 'tablet', profileId: 'saved-profile', url: page.url })
  expect(current.loading).toBe(false)
})

it('public inspection preserves cold and unavailable identities without claiming a native document, then reports the matching live snapshot', async () => {
  const cold = hydratePersistedTab(reducePersistedTab(savedTab('cold-page')))
  const unavailable = savedTab('unavailable-page'), unavailableRegion = unavailable.regions['region-unavailable-page'] as BrowserWorkbenchSurface
  unavailable.regions[unavailableRegion.regionId] = { ...unavailableRegion, nativeOwnerUnavailable: true }
  const live = savedTab('live-page'), legacy = savedTab('legacy-page')
  ;(legacy.regions['region-legacy-page'] as BrowserWorkbenchSurface).navigationId = ''
  const tabs = Object.fromEntries([cold, unavailable, live, legacy].map(tab => [tab.id, tab]))
  useAppStore.setState({ tabs, layouts: { workspace: createWorkspaceLayout('saved-group', Object.keys(tabs)) }, activeWorkspaceId: 'workspace' })
  const create = vi.spyOn(api.browser, 'create'), restore = vi.spyOn(api.browser, 'restore'), before = useAppStore.getState()
  async function inspect() {
    const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'inspect-original-browser-owners', operation: 'inspect.client' })
    if (result.operation !== 'inspect.client') throw new Error('Wrong public observation')
    const observation = desktopWorkbenchObservationSchema.parse(result.observation)
    return observation.tabs.flatMap(tab => tab.regions).filter(region => region.kind === 'browser')
  }
  const initial = await inspect()
  expect(initial.map(region => region.browserId)).toEqual(['cold-page', 'unavailable-page', 'live-page', 'legacy-page'])
  for (const id of ['cold-page', 'unavailable-page', 'legacy-page']) expect(initial.find(region => region.browserId === id)).toMatchObject({ navigationId: null, nativeOwner: 'unconfirmed' })
  expect(initial.find(region => region.browserId === 'live-page')).toMatchObject({ navigationId: page.navigationId })
  expect(useAppStore.getState()).toBe(before); expect(create).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
  useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...page, id: 'cold-page' } })
  const confirmed = (await inspect()).find(region => region.browserId === 'cold-page')!
  expect(confirmed.navigationId).toBe(page.navigationId); expect(confirmed).not.toHaveProperty('nativeOwner')
})

it('does not acquire a cold owner for hidden mounting or unrelated commits; first visibility uses restore', async () => {
  const restore = vi.spyOn(api.browser, 'restore').mockReturnValue(new Promise(() => {})), create = vi.spyOn(api.browser, 'create')
  const register = vi.spyOn(api.browser, 'registerPresentation')
  const tab = coldSurface()
  await act(async () => root.render(<BrowserPane tab={tab} visible={false} />))
  await act(async () => root.render(<BrowserPane tab={{ ...tab, title: 'Updated description' }} visible={false} />))
  expect(restore).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  expect(register).not.toHaveBeenCalled(); expect(host.querySelector('video')).toBeNull()
  await act(async () => root.render(<BrowserPane tab={tab} visible />))
  expect(restore).toHaveBeenCalledExactlyOnceWith(page.id, { workspaceId: 'workspace', profileId: 'saved-profile', mode: 'normal', viewport: 'tablet' })
  expect(host.textContent).toContain('Restoring browser')
})

it('a visible presentation is a real consumer even when the primary occurrence is hidden', async () => {
  const restore = vi.spyOn(api.browser, 'restore').mockReturnValue(new Promise(() => {}))
  const presentation = { stageHostId: 'visible-mirror', occurrence: { presentationId: 'visible-mirror', location: {
    displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab-page', regionId: 'region-page' } },
    visible: true, active: false, yieldToFocusRing: false, target: { hostId: 'visible-mirror', active: false, visible: true } }
  await act(async () => root.render(<BrowserPane tab={coldSurface()} visible={false} presentations={[presentation]} />))
  expect(restore).toHaveBeenCalledOnce()
})

it('keeps a pending acquisition through hiding, then preserves the original address draft and DOM on confirmation', async () => {
  let resolve!: (snapshot: BrowserSnapshot) => void
  const restore = vi.spyOn(api.browser, 'restore').mockReturnValue(new Promise(yes => { resolve = yes }))
  const release = vi.spyOn(api.browser, 'release'), tab = coldSurface()
  await act(async () => root.render(<BrowserPane tab={tab} visible />))
  await fill('Unsent next address'); const originalInput = address(); originalInput.setSelectionRange(2, 9)
  await act(async () => root.render(<BrowserPane tab={tab} visible={false} />))
  await act(async () => resolve(page))
  const { nativeOwnerDeferred: _deferred, ...confirmed } = tab
  await act(async () => root.render(<BrowserPane tab={{ ...confirmed, ...page }} visible />))
  expect(restore).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled()
  expect(address()).toBe(originalInput); expect(address().value).toBe('Unsent next address')
  expect([address().selectionStart, address().selectionEnd]).toEqual([2, 9])
  expect(host.textContent).not.toContain('Restoring browser')
})

it('keeps the same cold description and human draft through failure, then exact Retry succeeds', async () => {
  const restore = vi.spyOn(api.browser, 'restore').mockRejectedValueOnce(new Error('Original Profile is unavailable')).mockResolvedValueOnce(page)
  const tab = coldSurface(), close = vi.fn(), apply = vi.spyOn(useAppStore.getState(), 'applyBrowserEvent')
  await act(async () => root.render(<BrowserPane tab={tab} visible onRegionClose={close} />))
  await fill('Preserved search draft')
  expect(host.textContent).toContain('Original Profile is unavailable'); expect(address().value).toBe('Preserved search draft')
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry connection')!
  expect(retry).toBeDefined(); await act(async () => retry.click())
  expect(restore).toHaveBeenCalledTimes(2); expect(restore.mock.calls[1]).toEqual(restore.mock.calls[0])
  expect(apply).toHaveBeenCalledWith({ type: 'updated', browser: page }, ''); expect(close).not.toHaveBeenCalled()
  expect(address().value).toBe('Preserved search draft')
})

it('the real Store consumer clears deferred and unknown viewport only after the matching Main snapshot', async () => {
  const saved = savedTab(), cold = coldSurface()
  useAppStore.setState({ tabs: { [saved.id]: { ...saved, regions: { [cold.regionId]: { ...cold, restoredViewportUnknown: true } } } } })
  let resolve!: (snapshot: BrowserSnapshot) => void
  vi.spyOn(api.browser, 'restore').mockReturnValue(new Promise(yes => { resolve = yes }))
  function ActualPane() {
    const surface = useAppStore(state => state.tabs[saved.id]!.regions[cold.regionId] as BrowserWorkbenchSurface)
    return <BrowserPane tab={surface} visible />
  }
  await act(async () => root.render(<ActualPane />)); await fill('Same unsent input')
  const input = address()
  await act(async () => resolve(page))
  expect(address()).toBe(input); expect(input.value).toBe('Same unsent input')
  const confirmed = useAppStore.getState().tabs[saved.id]!.regions[cold.regionId]
  expect(confirmed).not.toHaveProperty('nativeOwnerDeferred'); expect(confirmed).not.toHaveProperty('restoredViewportUnknown')
  expect(confirmed).toMatchObject({ browserId: page.id, navigationId: page.navigationId, viewport: 'tablet' })
  expect(host.textContent).not.toContain('Restoring browser'); expect(host.textContent).not.toContain('Browser parked')
})

it('a mounted present owner consumes an exact unavailable event once, preserves failure, and offers same-identity Retry', async () => {
  const saved = savedTab(), surface = saved.regions['region-page'] as BrowserWorkbenchSurface
  useAppStore.setState({ tabs: { [saved.id]: saved } })
  const restore = vi.spyOn(api.browser, 'restore').mockRejectedValueOnce(new Error('The original owner is still unavailable')).mockResolvedValueOnce(page)
  function ActualPane() {
    const original = useAppStore(state => state.tabs[saved.id]!.regions[surface.regionId] as BrowserWorkbenchSurface)
    return <BrowserPane tab={original} visible />
  }
  await act(async () => root.render(<ActualPane />)); expect(restore).not.toHaveBeenCalled()
  await fill('Keep this recovery draft'); const originalInput = address()
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'unavailable', id: page.id, error: 'The original native page ended' }))
  expect(restore).toHaveBeenCalledOnce(); expect(host.textContent).toContain('The original owner is still unavailable')
  await act(async () => root.render(<ActualPane />)); expect(restore).toHaveBeenCalledOnce()
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry connection')!
  expect(retry).toBeDefined(); await act(async () => retry.click())
  expect(restore).toHaveBeenCalledTimes(2); expect(restore.mock.calls[0]).toEqual(restore.mock.calls[1])
  expect(address()).toBe(originalInput); expect(originalInput.value).toBe('Keep this recovery draft')
  expect(useAppStore.getState().tabs[saved.id]!.regions[surface.regionId]).not.toHaveProperty('nativeOwnerUnavailable')
  expect(host.textContent).not.toContain('The original owner is still unavailable')
})

it('persists the actual viewport and preserves missing historical metadata as unknown', () => {
  const persisted = reducePersistedTab(savedTab()), cold = hydratePersistedTab(persisted)
  expect(persisted.regions['region-page']).toHaveProperty('viewport', 'tablet')
  expect(cold.regions['region-page']).toMatchObject({ nativeOwnerDeferred: true, viewport: 'tablet', navigationId: '' })
  const old: PersistedWorkbenchTab = structuredClone(persisted)
  delete (old.regions['region-page'] as { viewport?: string }).viewport
  expect(old.regions['region-page']).not.toHaveProperty('viewport')
  const previous = hydratePersistedTab(old)
  expect(previous.regions['region-page']).toMatchObject({ nativeOwnerDeferred: true, restoredViewportUnknown: true, viewport: 'responsive' })
  expect(reducePersistedTab(previous).regions['region-page']).not.toHaveProperty('viewport')
})

it('round-trips custom viewport dimensions through the original cold persistence owner without sharing mutable input', () => {
  const tab = savedTab(), surface = tab.regions['region-page'] as BrowserWorkbenchSurface
  const viewport = { width: 640, height: 480, screenPosition: 'desktop' as const }
  surface.viewport = viewport
  const persisted = reducePersistedTab(tab)
  const descriptor = persisted.regions['region-page'] as { viewport?: typeof viewport }
  expect(descriptor.viewport).toEqual(viewport); expect(descriptor.viewport).not.toBe(viewport)
  viewport.width = 320
  const restored = hydratePersistedTab(persisted), cold = restored.regions['region-page'] as BrowserWorkbenchSurface
  expect(cold.viewport).toEqual({ width: 640, height: 480, screenPosition: 'desktop' })
  expect(cold).toMatchObject({ nativeOwnerDeferred: true, navigationId: '' })
  expect(cold).not.toHaveProperty('restoredViewportUnknown')
  expect(cold.viewport).not.toBe(descriptor.viewport)
  expect(Object.isFrozen(cold.viewport)).toBe(true)
  expect(reducePersistedTab(restored).regions['region-page']).toMatchObject({ viewport: cold.viewport })
})

function recoveryButton(name: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Browser recovery"] button')]
    .find(button => button.getAttribute('aria-label') === name || button.textContent === name)
  expect(button).toBeDefined()
  return button!
}

it('identifies the original failed page and edits its existing draft without navigation or submission', async () => {
  const tab = { ...savedTab().regions['region-page'] as BrowserWorkbenchSurface, error: 'ERR_CONNECTION_REFUSED (-102)' }
  const create = vi.spyOn(api.browser, 'create'), navigate = vi.spyOn(api.browser, 'navigate'), reload = vi.spyOn(api.browser, 'reload')
  await act(async () => root.render(<BrowserPane tab={tab} visible />))
  expect(host.querySelector('.browser-recovery__identity h2')?.textContent).toBe(page.title)
  expect(host.querySelector('.browser-recovery__address code')?.textContent).toBe(page.url)
  const details = host.querySelector<HTMLDetailsElement>('details.browser-recovery__details')!
  expect(details.open).toBe(false)
  expect(details.querySelector('pre')?.textContent).toBe(tab.error)
  expect(host.querySelector('[aria-label="Browser recovery"] img')).toBeNull()
  await fill('Unsent address draft')
  const input = address()
  await act(async () => recoveryButton('Edit address').click())
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('Unsent address draft')
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length])
  expect(create).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled()
})

it('copies the exact failed page address only after clipboard confirmation, independently of its unsent draft', async () => {
  const tab = { ...savedTab().regions['region-page'] as BrowserWorkbenchSurface, error: 'Original page is unavailable' }
  let copied!: () => void
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockImplementation(() => new Promise(resolve => { copied = resolve }))
  await act(async () => root.render(<BrowserPane tab={tab} visible />)); await fill('Different unsent search')
  await act(async () => recoveryButton('Copy page address').click())
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(page.url)
  expect(host.textContent).not.toContain('Address copied')
  await act(async () => copied())
  expect(host.querySelector('.browser-recovery__copy-result')?.textContent).toBe('Address copied')
  expect(address().value).toBe('Different unsent search')
})

it('keeps Retry and editing available when copying fails without reporting a copied address', async () => {
  const tab = { ...savedTab().regions['region-page'] as BrowserWorkbenchSurface, error: 'Original page is unavailable' }
  const report = vi.spyOn(useAppStore.getState(), 'reportError')
  vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValue(new Error('Clipboard unavailable'))
  await act(async () => root.render(<BrowserPane tab={tab} visible />))
  await act(async () => recoveryButton('Copy page address').click())
  expect(report).toHaveBeenCalled()
  expect(host.textContent).toContain('Address could not be copied')
  expect(host.textContent).not.toContain('Address copied')
  expect(recoveryButton('Retry').disabled).toBe(false)
  expect(recoveryButton('Edit address').disabled).toBe(false)
})

it('Retry retains the exact failed Browser and reloads only after the original owner still reports an error', async () => {
  const tab = { ...savedTab().regions['region-page'] as BrowserWorkbenchSurface, error: 'Original page is unavailable' }
  let acquired!: (snapshot: BrowserSnapshot) => void
  const create = vi.spyOn(api.browser, 'create').mockImplementation(() => new Promise(resolve => { acquired = resolve }))
  const reload = vi.spyOn(api.browser, 'reload').mockResolvedValue(page)
  const apply = vi.spyOn(useAppStore.getState(), 'applyBrowserEvent')
  await act(async () => root.render(<BrowserPane tab={tab} visible />))
  await act(async () => recoveryButton('Retry').click())
  expect(create).toHaveBeenCalledExactlyOnceWith(page.id, page.url, 'workspace', page.profileId, page.mode)
  expect(reload).not.toHaveBeenCalled()
  expect(recoveryButton('Retry').disabled).toBe(true)
  expect(recoveryButton('Edit address').disabled).toBe(false)
  await act(async () => acquired({ ...page, error: tab.error }))
  expect(reload).toHaveBeenCalledExactlyOnceWith(page.id)
  expect(apply).toHaveBeenCalledWith({ type: 'updated', browser: page })
})
