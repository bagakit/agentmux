import { describe, expect, it } from 'vitest'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs.js'
import { reducePersistedTab, hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence.js'
import { reduceBrowserEvent } from '../src/renderer/src/lib/browser-state.js'
import type { BrowserSnapshot } from '../src/shared/contracts.js'

function snapshot(mode: BrowserSnapshot['mode']): BrowserSnapshot {
  return { id: 'private-browser', mode, profileId: mode === 'private' ? null : 'saved-profile', navigationId: 'live-nav', url: 'https://private.example/secret?q=private-secret#fragment', title: 'Private secret title', faviconDataUrl: 'data:image/png;base64,private-artwork', loading: false, canGoBack: true, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null }
}

describe('private Browser projection at the actual Workbench persistence boundary', () => {
  it('keeps the original mixed Region layout while private address, artwork and Profile never enter saved projection', () => {
    const current = snapshot('private')
    const browser = createWorkbenchTab('original-tab', { ...current, regionId: 'private-region', kind: 'browser', workspaceId: 'workspace', browserId: current.id, bookmarkOrigin: { path: 'private-origin.webloc', binary: false } })
    const mixed = addWorkbenchRegion(browser, 'private-region', 'right', { regionId: 'healthy-sibling', kind: 'launcher', workspaceId: 'workspace' })
    const saved = reducePersistedTab(mixed), bytes = JSON.stringify(saved)
    for (const secret of ['private.example', 'private-secret', 'Private secret title', 'private-artwork', 'private-origin.webloc', 'live-nav']) expect(bytes).not.toContain(secret)
    expect(saved.regions['private-region']).toMatchObject({ browserId: current.id, mode: 'private', url: 'about:blank' })
    const restored = hydratePersistedTab(JSON.parse(bytes))
    expect(restored.id).toBe(mixed.id)
    expect(restored.layout).toEqual(mixed.layout)
    expect(restored.regions['healthy-sibling']).toEqual(mixed.regions['healthy-sibling'])
    expect(restored.regions['private-region']).toMatchObject({ mode: 'private', profileId: null, url: 'about:blank', privateSessionEnded: true })
    const next = reduceBrowserEvent({ tabs: { [mixed.id]: restored }, layouts: {} }, { type: 'updated', browser: { ...current, url: 'https://fresh.example/' } })
    expect(next.tabs[mixed.id]!.regions['private-region']).not.toHaveProperty('privateSessionEnded')
  })

  it('normal Browser retains its original address, title and Profile through the same writer and reader', () => {
    const current = snapshot('normal'), tab = createWorkbenchTab('normal-tab', { ...current, regionId: 'normal-region', kind: 'browser', workspaceId: 'workspace', browserId: current.id })
    expect(hydratePersistedTab(reducePersistedTab(tab)).regions['normal-region']).toMatchObject({ mode: 'normal', profileId: current.profileId, url: current.url, title: current.title })
  })
})
