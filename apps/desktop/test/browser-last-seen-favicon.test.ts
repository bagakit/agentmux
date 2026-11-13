// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import type { BrowserSnapshot } from '../src/shared/contracts'
import { reduceBrowserEvent, rememberBrowserFavicons, type BrowserProjectionState } from '../src/renderer/src/lib/browser-state'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { observeLastSeenBrowserFavicons } from '../src/renderer/src/lib/browser-last-seen-favicons'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const seen = 'data:image/png;base64,AA==', current = 'data:image/png;base64,BB=='
const address = 'https://example.test/page'
function surface(overrides: Partial<BrowserWorkbenchSurface> = {}, browserId = 'browser'): BrowserWorkbenchSurface {
  return { regionId: `region-${browserId}`, browserId, id: browserId, kind: 'browser', mode: 'normal', workspaceId: 'workspace',
    navigationId: 'old-document', url: address, title: 'Page', profileId: 'profile', driving: false, appLinkPrompt: null,
    loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, ...overrides }
}
function snapshot(overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return { id: 'browser', mode: 'normal', navigationId: 'new-document', url: address, title: 'Page', profileId: 'profile',
    driving: false, appLinkPrompt: null, loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null,
    faviconDataUrl: undefined, ...overrides }
}
const project = (value: BrowserWorkbenchSurface): BrowserProjectionState => ({ tabs: { tab: createWorkbenchTab('tab', value) }, layouts: {} })
const only = (state: Pick<BrowserProjectionState, 'tabs'>, browserId = 'browser') =>
  state.tabs.tab!.regions[`region-${browserId}`] as BrowserWorkbenchSurface

describe('a parked Browser keeps the icon last seen at its address', () => {
  it('keeps a released page icon through restore until its own document reports one', () => {
    let state = project(surface({ faviconDataUrl: seen }))
    state = reduceBrowserEvent(state, { type: 'released', id: 'browser', navigationId: 'old-document' })
    state = reduceBrowserEvent(state, { type: 'updated', browser: snapshot() })
    expect(only(state)).toMatchObject({ faviconDataUrl: seen, faviconRemembered: true, navigationId: 'new-document' })
    expect(only(state).nativeOwnerReleased).toBeUndefined()
    expect(reduceBrowserEvent(state, { type: 'updated', browser: snapshot() }), 'an unchanged snapshot is not a new projection').toBe(state)
    const loading = reduceBrowserEvent(state, { type: 'updated', browser: snapshot({ loading: true }) })
    expect(only(loading)).toMatchObject({ faviconDataUrl: seen, faviconRemembered: true, loading: true })
    state = reduceBrowserEvent(loading, { type: 'updated', browser: snapshot({ faviconDataUrl: current }) })
    expect(only(state).faviconDataUrl).toBe(current)
    expect(only(state).faviconRemembered).toBeUndefined()
  })

  it('drops a remembered icon as soon as the page is at another address', () => {
    for (const parked of [{ nativeOwnerDeferred: true as const }, { nativeOwnerReleased: true as const }, { faviconRemembered: true as const }]) {
      const state = reduceBrowserEvent(project(surface({ faviconDataUrl: seen, ...parked })), { type: 'updated', browser: snapshot({ url: 'https://example.test/other' }) })
      expect(only(state).faviconDataUrl, JSON.stringify(parked)).toBeUndefined()
      expect(only(state).faviconRemembered).toBeUndefined()
    }
  })

  it('still clears a live page icon when its new document reports none', () => {
    const state = reduceBrowserEvent(project(surface({ faviconDataUrl: current })), { type: 'updated', browser: snapshot() })
    expect(only(state).faviconDataUrl).toBeUndefined()
    expect(only(state).faviconRemembered).toBeUndefined()
  })

  it('fills only a parked page without an icon at the remembered address', () => {
    const found = { browser: { url: address, faviconDataUrl: seen } }
    const cold = project(surface({ nativeOwnerDeferred: true, navigationId: '' }))
    expect(only({ tabs: rememberBrowserFavicons(cold.tabs, found) })).toMatchObject({ faviconDataUrl: seen, faviconRemembered: true })
    const released = project(surface({ nativeOwnerReleased: true }))
    expect(only({ tabs: rememberBrowserFavicons(released.tabs, found) })).toMatchObject({ faviconDataUrl: seen, faviconRemembered: true })
    for (const unchanged of [
      project(surface({ nativeOwnerDeferred: true, url: 'https://example.test/moved' })),
      project(surface()),
      project(surface({ nativeOwnerUnavailable: true })),
      project(surface({ nativeOwnerDeferred: true, faviconDataUrl: current }))
    ]) expect(rememberBrowserFavicons(unchanged.tabs, found)).toBe(unchanged.tabs)
  })
})

describe('last-seen icon observer', () => {
  const initial = useAppStore.getState()
  afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  it('asks Main once per parked page and address, then fills the matching page', async () => {
    const read = vi.spyOn(api.browser, 'getLastSeenFavicons').mockResolvedValue({ browser: { url: address, faviconDataUrl: seen } })
    useAppStore.setState({ tabs: {
      tab: createWorkbenchTab('tab', surface({ nativeOwnerDeferred: true, navigationId: '' })),
      other: createWorkbenchTab('other', surface({}, 'live-browser')),
      blank: createWorkbenchTab('blank', surface({ nativeOwnerDeferred: true, url: 'about:blank' }, 'blank-browser'))
    } })
    const dispose = observeLastSeenBrowserFavicons()
    await vi.waitFor(() => expect(only(useAppStore.getState())).toMatchObject({ faviconDataUrl: seen, faviconRemembered: true }))
    expect(read).toHaveBeenCalledExactlyOnceWith(['browser'])
    dispose()
  })

  it('does not ask again for the same address, asks for a new one and stops after dispose', async () => {
    const read = vi.spyOn(api.browser, 'getLastSeenFavicons').mockResolvedValue({})
    const subscribe = useAppStore.subscribe
    let subscribers = 0
    vi.spyOn(useAppStore, 'subscribe').mockImplementation(listener => {
      subscribers++
      const stop = subscribe(listener)
      return () => { subscribers--; stop() }
    })
    useAppStore.setState({ tabs: { tab: createWorkbenchTab('tab', surface({ nativeOwnerDeferred: true, navigationId: '' })) } })
    const dispose = observeLastSeenBrowserFavicons()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    useAppStore.setState(state => ({ tabs: { ...state.tabs } }))
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    useAppStore.setState({ tabs: { tab: createWorkbenchTab('tab', surface({ nativeOwnerDeferred: true, navigationId: '', url: 'https://example.test/next' })) } })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(subscribers).toBe(1)
    dispose()
    expect(subscribers, 'dispose releases the Store subscription').toBe(0)
    useAppStore.setState({ tabs: { tab: createWorkbenchTab('tab', surface({ nativeOwnerDeferred: true, navigationId: '', url: 'https://example.test/third' })) } })
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
  })
})
