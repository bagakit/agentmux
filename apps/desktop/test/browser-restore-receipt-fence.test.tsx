// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { desktopWorkbenchObservationSchema } from '../src/shared/client-observation'
import type { BrowserSnapshot } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'

const initial = useAppStore.getState()
const tabId = 'receipt-tab', regionId = 'receipt-region', workspaceId = 'receipt-workspace'
const page: BrowserSnapshot = {
  id: 'receipt-browser', navigationId: 'original-document', mode: 'normal', profileId: 'original-profile',
  url: 'https://example.invalid/original', title: 'Original page', viewport: 'tablet',
  loading: false, canGoBack: false, canGoForward: false, error: null, driving: false, appLinkPrompt: null
}
let root: ReturnType<typeof createClientUiRoot>, container: HTMLDivElement, committedNavigation: string

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function surface(): BrowserWorkbenchSurface {
  const value = useAppStore.getState().tabs[tabId]!.regions[regionId]!
  if (value.kind !== 'browser') throw new Error('The original Browser Region was replaced')
  return value
}
function ConnectedPane() {
  const current = useAppStore(state => state.tabs[tabId]!.regions[regionId]!)
  if (current.kind !== 'browser') throw new Error('The original Browser Region was replaced')
  return <PaneSnapshot current={current} />
}
function PaneSnapshot({ current }: { current: BrowserWorkbenchSurface }) {
  useLayoutEffect(() => { committedNavigation = current.navigationId }, [current.navigationId])
  return <BrowserPane tab={current} visible />
}
function address() {
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')
  expect(field).not.toBeNull()
  return field!
}
async function draft() {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address(), 'keep this address draft')
    address().dispatchEvent(new Event('input', { bubbles: true }))
    address().setSelectionRange(5, 9)
  })
}
async function inspectBrowser() {
  const result = await useAppStore.getState().executeControl({
    schemaVersion: 5, requestId: 'receipt-observation', operation: 'inspect.client'
  })
  if (result.operation !== 'inspect.client') throw new Error('Unexpected observation operation')
  const observed = desktopWorkbenchObservationSchema.parse(result.observation)
  const region = observed.tabs.find(tab => tab.id === tabId)!.regions.find(region => region.regionId === regionId)!
  if (region.kind !== 'browser') throw new Error('The original Browser observation was replaced')
  return region
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const tab = createWorkbenchTab(tabId, { ...page, nativeOwnerReleased: true,
    kind: 'browser', browserId: page.id, regionId, workspaceId })
  const config = await api.config.get()
  config.workspaces = [{ id: workspaceId, name: 'Receipt workspace', hostId: 'local',
    path: join(tmpdir(), 'browser-receipt-workspace'), kind: 'folder' }]
  useAppStore.setState({ ...initial, config, loading: false, toolsOpen: false,
    tabs: { [tabId]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('receipt-group', [tabId]) },
    activeWorkspaceId: workspaceId, mainSurface: 'workbench' }, true)
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container)
  committedNavigation = ''
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})

it('rejects an old restore after Main updates the Store before React commits, preserving the draft', async () => {
  const waiting = deferred<BrowserSnapshot>()
  const restore = vi.spyOn(api.browser, 'restore').mockReturnValue(waiting.promise)
  const apply = vi.spyOn(useAppStore.getState(), 'applyBrowserEvent')
  // Hold the parent's last committed props while Main writes the real Store. This models the
  // uncommitted interval explicitly, without relying on React's microtask scheduling in this host.
  await act(async () => root.render(<PaneSnapshot current={surface()} />))
  await draft()
  expect(restore).toHaveBeenCalledOnce()
  expect(committedNavigation).toBe(page.navigationId)
  const newer = { ...page, navigationId: 'newer-main-document', url: 'https://example.invalid/newer', title: 'Newer Main page' }
  const stale = { ...page, navigationId: 'older-restore-document', url: 'https://example.invalid/older' }
  await act(async () => {
    useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: newer })
    expect(surface().navigationId).toBe(newer.navigationId)
    expect(committedNavigation).toBe(page.navigationId)
    waiting.resolve(stale)
    await waiting.promise
    // The actual Pane receipt consumer must run while its render still has the original source.
    expect(apply).toHaveBeenCalledWith({ type: 'updated', browser: stale }, page.navigationId)
    expect(committedNavigation).toBe(page.navigationId)
    expect(surface().navigationId).toBe(newer.navigationId)
    root.render(<PaneSnapshot current={surface()} />)
  })
  expect(surface()).toMatchObject({ navigationId: newer.navigationId, url: newer.url, title: newer.title })
  expect(surface().nativeOwnerReleased).toBeUndefined()
  expect(committedNavigation).toBe(newer.navigationId)
  expect(address().value).toBe('keep this address draft')
  expect(address().selectionStart).toBe(5); expect(address().selectionEnd).toBe(9)
  expect(container.textContent).not.toContain('Restoring browser')
})

it('accepts a matching restore and then a later Main update without a receipt fence, keeping the draft', async () => {
  const waiting = deferred<BrowserSnapshot>()
  vi.spyOn(api.browser, 'restore').mockReturnValue(waiting.promise)
  await act(async () => root.render(<ConnectedPane />))
  await draft()
  const restored = { ...page, navigationId: 'restored-document' }
  await act(async () => waiting.resolve(restored))
  expect(surface().navigationId).toBe(restored.navigationId)
  expect(surface().nativeOwnerReleased).toBeUndefined()
  expect((await inspectBrowser()).navigationId).toBe(restored.navigationId)
  const later = { ...restored, navigationId: 'later-main-document', url: 'https://example.invalid/later' }
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: later }))
  expect(surface().navigationId).toBe(later.navigationId)
  expect(address().value).toBe('keep this address draft')
  expect(container.textContent).not.toContain('Restoring browser')
})

it('observes a released owner without a confirmed navigation and confirms the later native owner', async () => {
  expect(surface().navigationId).toBe(page.navigationId)
  expect(await inspectBrowser()).toMatchObject({ browserId: page.id, navigationId: null, nativeOwner: 'unconfirmed' })
  const restored = { ...page, navigationId: 'confirmed-main-document' }
  useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: restored })
  const observed = await inspectBrowser()
  expect(observed.navigationId).toBe(restored.navigationId)
  expect(observed.nativeOwner).toBeUndefined()
  expect(surface().browserId).toBe(page.id)
})
