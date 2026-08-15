import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { BrowserSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import type { OpenDestination, OpenHttpLinkOrigin } from '../src/renderer/src/lib/open-destination.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  replaceWorkbenchRegion,
  workbenchSurfaces
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function browserSnapshot(id: string, url: string): BrowserSnapshot {
  return {
    id,
    navigationId: `${id}:navigation`,
    profileId: 'profile:default',
    url,
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: 'responsive',
    error: null,
    driving: false
  }
}

function setupOrigin(): OpenHttpLinkOrigin {
  const tabId = 'terminal-tab'
  const regionId = 'terminal-region'
  const tab = createWorkbenchTab(tabId, {
    regionId,
    kind: 'terminal',
    phase: 'attached',
    workspaceId: 'workspace',
    sessionId: 'terminal-session'
  })
  useAppStore.setState({
    activeWorkspaceId: 'workspace',
    tabs: { [tabId]: tab },
    layouts: { workspace: createWorkspaceLayout('pane', [tabId]) },
    closingWorkbenchViews: {},
    error: null
  })
  return { workspaceId: 'workspace', tabGroupId: 'pane', tabId, regionId }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('HTTP link routing ownership', () => {
  it('opens a canonical HTTP(S) URL through the system boundary without creating Browser state', async () => {
    const openExternal = vi.spyOn(api.ui, 'openExternal').mockResolvedValue()
    const create = vi.spyOn(api.browser, 'create')

    await useAppStore.getState().openHttpLink(
      { workspaceId: 'workspace', tabGroupId: 'pane' },
      'https://example.com/docs',
      'system'
    )

    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(create).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs).toEqual({})
  })

  it('rejects non-HTTP(S) URLs before either external or internal ownership changes', async () => {
    const openExternal = vi.spyOn(api.ui, 'openExternal')
    const create = vi.spyOn(api.browser, 'create')

    await expect(useAppStore.getState().openHttpLink(
      { workspaceId: 'workspace', tabGroupId: 'pane' },
      'file:///tmp/private',
      'system'
    )).rejects.toThrow('Link URL protocol is not allowed: file:')
    await expect(useAppStore.getState().openHttpLink(
      { workspaceId: 'workspace', tabGroupId: 'pane' },
      'javascript:alert(1)',
      'tab'
    )).rejects.toThrow('Link URL protocol is not allowed: javascript:')

    expect(openExternal).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs).toEqual({})
  })

  it('atomically publishes a Launcher Tab in the exact origin group before creating its Browser', async () => {
    const origin = setupOrigin()
    const pending = deferred<BrowserSnapshot>()
    const create = vi.spyOn(api.browser, 'create').mockImplementation(async (regionId, url) => {
      const state = useAppStore.getState()
      const group = state.layouts.workspace?.groups.find(({ id }) => id === 'pane')
      const pendingTab = Object.values(state.tabs).find((tab) => (
        tab.id !== origin.tabId && tab.regions[regionId]?.kind === 'launcher'
      ))
      expect(group?.activeTabId).toBe(pendingTab?.id)
      expect(group?.tabOrder).toContain(pendingTab?.id)
      expect(url).toBe('https://example.com/docs')
      return await pending.promise
    })

    const opening = useAppStore.getState().openHttpLink(origin, 'https://example.com/docs', 'tab')
    const pendingTab = Object.values(useAppStore.getState().tabs).find((tab) => tab.id !== origin.tabId)!
    const regionId = pendingTab.layout.activeRegionId
    expect(pendingTab.regions[regionId]).toMatchObject({ kind: 'launcher', workspaceId: 'workspace' })

    pending.resolve(browserSnapshot(regionId, 'https://example.com/docs'))
    await opening

    expect(create).toHaveBeenCalledWith(regionId, 'https://example.com/docs')
    expect(useAppStore.getState().tabs[pendingTab.id]?.regions[regionId]).toMatchObject({
      kind: 'browser',
      browserId: regionId,
      url: 'https://example.com/docs'
    })
  })

  it.each([
    ['left', 'horizontal', 'first'],
    ['right', 'horizontal', 'second'],
    ['up', 'vertical', 'first'],
    ['down', 'vertical', 'second']
  ] as const)(
    'opens %s in a new Browser Region on the requested split side',
    async (destination, axis, addedSide) => {
      const origin = setupOrigin()
      const create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => (
        browserSnapshot(id, url)
      ))

      await useAppStore.getState().openHttpLink(origin, 'https://example.com/path', destination)

      const tab = useAppStore.getState().tabs[origin.tabId!]!
      const browser = workbenchSurfaces(tab).find((surface) => surface.kind === 'browser')!
      expect(create).toHaveBeenCalledWith(browser.regionId, 'https://example.com/path')
      expect(tab.layout.activeRegionId).toBe(browser.regionId)
      expect(tab.layout.root).toMatchObject({ type: 'split', direction: axis })
      if (tab.layout.root.type !== 'split') throw new Error('Expected split layout')
      expect(tab.layout.root[addedSide]).toEqual({ type: 'leaf', regionId: browser.regionId })
      expect(tab.layout.root[addedSide === 'first' ? 'second' : 'first']).toEqual({
        type: 'leaf',
        regionId: origin.regionId
      })
    }
  )

  it.each([
    [{ workspaceId: 'workspace', tabGroupId: 'pane' }, 'missing identity'],
    [{
      workspaceId: 'workspace',
      tabGroupId: 'pane',
      tabId: 'terminal-tab',
      regionId: 'missing-region'
    }, 'stale Region']
  ] as const)('rejects a directional destination with a %s origin', async (partialOrigin) => {
    setupOrigin()
    const create = vi.spyOn(api.browser, 'create')

    await expect(useAppStore.getState().openHttpLink(
      partialOrigin,
      'https://example.com/',
      'right'
    )).rejects.toThrow(/Directional link destinations require|Link origin Region is no longer available/)

    expect(create).not.toHaveBeenCalled()
    expect(workbenchSurfaces(useAppStore.getState().tabs['terminal-tab']!)).toHaveLength(1)
  })

  it('closes a late Browser instead of replacing a competing owner in the same Region', async () => {
    const origin = setupOrigin()
    const pending = deferred<BrowserSnapshot>()
    vi.spyOn(api.browser, 'create').mockImplementation(async () => await pending.promise)
    const close = vi.spyOn(api.browser, 'close').mockResolvedValue()

    const opening = useAppStore.getState().openHttpLink(origin, 'https://example.com/', 'right')
    const plannedTab = useAppStore.getState().tabs[origin.tabId!]!
    const pendingSurface = workbenchSurfaces(plannedTab).find(({ kind }) => kind === 'launcher')!
    const competitor = { ...pendingSurface }
    useAppStore.setState((state) => ({
      tabs: {
        ...state.tabs,
        [plannedTab.id]: replaceWorkbenchRegion(state.tabs[plannedTab.id]!, pendingSurface.regionId, competitor)
      }
    }))

    pending.resolve(browserSnapshot('late-browser', 'https://example.com/'))
    await opening

    expect(close).toHaveBeenCalledWith('late-browser')
    expect(useAppStore.getState().tabs[plannedTab.id]?.regions[pendingSurface.regionId]).toBe(competitor)
  })

  it.each(['tab', 'right'] as const)(
    'rolls back only its pending %s destination when Browser creation fails',
    async (destination: Extract<OpenDestination, 'tab' | 'right'>) => {
      const origin = setupOrigin()
      const originalTab = useAppStore.getState().tabs[origin.tabId!]!
      vi.spyOn(api.browser, 'create').mockRejectedValue(new Error('browser create failed'))

      await expect(useAppStore.getState().openHttpLink(
        origin,
        'https://example.com/',
        destination
      )).rejects.toThrow('browser create failed')

      const state = useAppStore.getState()
      expect(Object.keys(state.tabs)).toEqual([origin.tabId])
      expect(state.tabs[origin.tabId!]).toEqual(originalTab)
      expect(state.layouts.workspace?.groups[0]).toMatchObject({
        id: 'pane',
        tabOrder: [origin.tabId],
        activeTabId: origin.tabId
      })
    }
  )

  it('reports both the lost owner and Browser cleanup failure without touching its competitor', async () => {
    const origin = setupOrigin()
    const pending = deferred<BrowserSnapshot>()
    vi.spyOn(api.browser, 'create').mockImplementation(async () => await pending.promise)
    vi.spyOn(api.browser, 'close').mockRejectedValue(new Error('browser close failed'))

    const opening = useAppStore.getState().openHttpLink(origin, 'https://example.com/', 'down')
    const plannedTab = useAppStore.getState().tabs[origin.tabId!]!
    const pendingSurface = workbenchSurfaces(plannedTab).find(({ kind }) => kind === 'launcher')!
    const competitor = { ...pendingSurface }
    useAppStore.setState((state) => ({
      tabs: {
        ...state.tabs,
        [plannedTab.id]: replaceWorkbenchRegion(state.tabs[plannedTab.id]!, pendingSurface.regionId, competitor)
      }
    }))

    pending.resolve(browserSnapshot('orphan-browser', 'https://example.com/'))
    await expect(opening).rejects.toThrow(
      'Browser launch owner disappeared before it could attach. Cleanup also failed: browser close failed'
    )

    expect(useAppStore.getState().error).toBe(
      'Browser launch owner disappeared before it could attach. Cleanup also failed: browser close failed'
    )
    expect(useAppStore.getState().tabs[plannedTab.id]?.regions[pendingSurface.regionId]).toBe(competitor)
  })
})
