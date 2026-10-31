// @vitest-environment happy-dom
import { act } from 'react'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { projectPersistedWorkbench, restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'

const initial = useAppStore.getState(), uri = 'amux://capsule/23456789ABCD'
let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, page: BrowserWorkbenchSurface
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  page = { ...await api.browser.create('capsule-address-browser', 'http://127.0.0.1:49152/nested/view?q=one#draft', 'workspace'),
    kind: 'browser', browserId: 'capsule-address-browser', regionId: 'original-region', workspaceId: 'workspace',
    capsuleId: '23456789ABCD', capsuleOrigin: 'http://127.0.0.1:49152', objectLink: uri, capsuleActive: false, profileId: null }
  const config = { ...await api.config.get(), workspaces: [{ id: 'workspace', name: 'Original', hostId: 'local', path: join(tmpdir(), 'capsule-address-fixture'), kind: 'folder' as const }] }
  useAppStore.setState({ ...initial, config, toolsOpen: false }, true)
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.getElementById('agentmux-window-overlay-host')?.remove()
})
async function render(next = page) { await act(async () => root.render(<BrowserPane visible tab={next} />)) }
function address() { return container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')! }
async function edit(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address(), value)
    address().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function enter() { await act(async () => address().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))) }

it('shows the original object address without requiring a handshake and submits it through the object owner', async () => {
  const open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined), navigate = vi.spyOn(api.browser, 'navigate').mockResolvedValue(page)
  await render(); expect(address().value).toBe(uri)
  await enter()
  expect(navigate).toHaveBeenCalledExactlyOnceWith(page.browserId, uri); expect(open).not.toHaveBeenCalled()
  expect(address().value).toBe(uri); expect(page.url).toContain('/nested/view?q=one#draft')
})

it('keeps an object navigation available while the current native connection is unavailable', async () => {
  const open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined), navigate = vi.spyOn(api.browser, 'navigate').mockResolvedValue(page)
  await act(async () => root.render(<BrowserPane visible released tab={page} />))
  expect(address().value).toBe(uri); await enter()
  expect(navigate).toHaveBeenCalledExactlyOnceWith(page.browserId, uri); expect(open).not.toHaveBeenCalled()
})

it('opens a different Capsule reference through the global object owner instead of reusing the old Browser partition', async () => {
  const target = 'amux://capsule/3456789ABCDE'
  const open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined), navigate = vi.spyOn(api.browser, 'navigate').mockResolvedValue(page)
  await render(); await edit(target); await enter()
  expect(open).toHaveBeenCalledExactlyOnceWith(target)
  expect(navigate).not.toHaveBeenCalled()
})

it('keeps an untouched submitted Capsule URI after the exact owner refuses its stale document and a later external observation arrives', async () => {
  const open = vi.spyOn(api.ui, 'openObjectLink')
  const navigate = vi.spyOn(api.browser, 'navigate').mockRejectedValue(new Error('The original Browser has left this Capsule document'))
  await render(); await enter()
  expect(navigate).toHaveBeenCalledExactlyOnceWith(page.browserId, uri)
  const { objectLink: _object, ...original } = page
  await render({ ...original, url: 'https://outside.invalid/actual-current-page' })
  expect(address().value).toBe(uri)
  expect(container.textContent).toContain('has left this Capsule document')
  expect(open).not.toHaveBeenCalled()
})

it('retains the entered address and original page after an unknown object opening and a later observation', async () => {
  const target = 'amux://capsule/3456789ABCDE'
  vi.spyOn(api.ui, 'openObjectLink').mockRejectedValue(new Error('Original operation original-open is unconfirmed'))
  await render(); await edit(target); await enter()
  expect(address().value).toBe(target)
  expect(container.textContent).toContain('original-open')
  await render({ ...page, url: 'http://127.0.0.1:49152/new-observed-route' })
  expect(address().value).toBe(target)
})

it('uses real external navigation after leaving the Capsule and preserves the explicit external-open target', async () => {
  const { objectLink: _original, ...external } = page
  const current = { ...external, url: 'https://outside.invalid/current' }
  const navigate = vi.spyOn(api.browser, 'navigate').mockResolvedValue(current), open = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
  await render(); await edit(current.url); await enter()
  expect(navigate).toHaveBeenCalledExactlyOnceWith(page.browserId, current.url)
  await render(current); expect(address().value).toBe(current.url)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open in external browser"]')!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith(current.url)
})

it('replaces the previous object address through actual Store events when the original Browser leaves and returns to the Capsule', async () => {
  const tab = createWorkbenchTab('original-tab', page)
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) } })
  function CurrentBrowser() {
    const current = useAppStore(state => state.tabs[tab.id]?.regions[page.regionId])
    return current?.kind === 'browser' ? <BrowserPane visible tab={current} /> : null
  }
  await act(async () => root.render(<CurrentBrowser />))
  expect(address().value).toBe(uri)
  const { objectLink: _object, ...original } = page
  const external = { ...original, url: 'https://outside.invalid/after-navigation', navigationId: 'original-external-navigation' }
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: external }))
  expect(useAppStore.getState().tabs[tab.id]!.regions[page.regionId]).not.toHaveProperty('objectLink')
  expect(address().value).toBe(external.url)
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...page, navigationId: 'original-return-navigation' } }))
  expect(address().value).toBe(uri)
  expect(useAppStore.getState().tabs[tab.id]!.regions[page.regionId]).toMatchObject({ objectLink: uri, url: page.url })
})

it('keeps later address editing when the earlier object owner finishes', async () => {
  let finish!: (page: BrowserWorkbenchSurface) => void
  const pending = new Promise<BrowserWorkbenchSurface>(resolve => { finish = resolve })
  const navigate = vi.spyOn(api.browser, 'navigate').mockReturnValue(pending)
  await render(); await enter()
  const laterDraft = 'amux://capsule/456789ABCDEF'
  await edit(laterDraft)
  await act(async () => finish(page))
  expect(navigate).toHaveBeenCalledExactlyOnceWith(page.browserId, uri)
  expect(address().value).toBe(laterDraft)
})

it('uses the latest original Browser observation after an earlier object opening finishes', async () => {
  let finish!: () => void
  vi.spyOn(api.ui, 'openObjectLink').mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  await render(); await edit('amux://capsule/3456789ABCDE'); await enter()
  const { objectLink: _object, ...external } = page
  const latest = { ...external, url: 'https://outside.invalid/latest' }
  await render(latest)
  await act(async () => finish())
  expect(address().value).toBe(latest.url)
})

it('copies the stable object address from recovery while external-open still uses the real HTTP document', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined), external = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
  await render({ ...page, error: 'Original service observation unavailable' })
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy page address"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(uri)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open in external browser"]')!.click())
  expect(external).toHaveBeenCalledExactlyOnceWith(page.url)
})

it('saves the stable object address and retains the original bookmark result on the same HTTP page', async () => {
  const save = vi.fn(async () => 'Original.webloc')
  useAppStore.setState({ saveBrowserBookmark: save })
  await render()
  await act(async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More browser tools"]')!
    trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  const item = document.querySelector<HTMLElement>('[aria-label="Save this page as a bookmark"]')!
  expect(item).not.toBeNull()
  await act(async () => item.click())
  expect(save).toHaveBeenCalledExactlyOnceWith('workspace', uri, page.title)
  expect(container.querySelector('.browser-bookmark-result')?.textContent).toContain('Original.webloc')
})

it('derives the same object address before native reconnect from the original persisted route and Region', () => {
  const tab = createWorkbenchTab('original-tab', page), config = useAppStore.getState().config!
  const saved = projectPersistedWorkbench({ tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) } })
  const restored = restorePersistedWorkbench({ config, sessions: [], persisted: JSON.parse(JSON.stringify(saved)), createTabGroupId: () => 'unused' })
  expect(restored.tabs[tab.id]!.regions[page.regionId]).toMatchObject({ objectLink: uri, url: page.url, browserId: page.browserId, regionId: page.regionId, nativeOwnerDeferred: true })
  expect(restored.tabs[tab.id]!.layout).toEqual(tab.layout)
  const savedBrowser = saved.tabs[tab.id]!.regions[page.regionId]!
  expect(savedBrowser).not.toHaveProperty('objectLink')
})
