// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { surveyProfileReferences, surveySelectionProfileMatch, readSurveyProfileView } from '../src/renderer/src/lib/survey-profile-view'
import { SurveyProfilePicker } from '../src/renderer/src/components/SurveyProfilePicker'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { parseSurveyProfileView, type AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { config } from './helpers/workface-control-fixture'
import { GlobalSurveySurface } from '../src/renderer/src/components/GlobalSurveySurface'
import { api } from '../src/renderer/src/lib/api'
import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { createWorkspaceLayout } from '@agentmux/layout'
const initial = useAppStore.getState(), a = 'profile-a', b = 'profile-b'
afterEach(() => { browserProfiles.reset(); vi.restoreAllMocks(); useAppStore.setState(initial, true) })
function fixture() {
  const surface = (regionId: string, browserId: string, profileId: string) => ({ regionId, browserId, id: browserId, kind: 'browser' as const,
    workspaceId: 'resource', mode: 'normal' as const, profileId, url: 'https://generic.invalid/', title: 'Page', navigationId: browserId + '-document',
    canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive' as const, error: null, driving: false, appLinkPrompt: null })
  let tab = createWorkbenchTab('mixed-study-tab', surface('region-a', 'browser-a', a))
  tab = addWorkbenchRegion(tab, 'region-a', 'right', surface('region-b', 'browser-b', b))
  tab = addWorkbenchRegion(tab, 'region-b', 'down', { regionId: 'original-file', kind: 'file', workspaceId: 'resource', path: 'unsaved.md' })
  const tabs = { [tab.id]: tab }, layout = createWorkspaceLayout('original-group', [tab.id])
  const catalog = { zones: [{ zoneId: 'whole-research' }], tabs: [{ tabId: tab.id, zoneId: 'whole-research' }], regions: Object.values(tab.regions).map(surface => ({ regionId: surface.regionId, tabId: tab.id, kind: surface.kind })), locations: [], bindings: [], spaces: [] } as unknown as AgentMuxSpaceCatalog
  return { tab, tabs, layout, catalog, pages: [{ regionId: 'region-a', browserId: 'browser-a' }, { regionId: 'region-b', browserId: 'browser-b' }] }
}
it('the strict public environment view preserves default versus an exact ID without adding authority fields', () => {
  expect(parseSurveyProfileView({ kind: 'default' })).toEqual({ kind: 'default' })
  expect(parseSurveyProfileView({ kind: 'profile', profileId: a })).toEqual({ kind: 'profile', profileId: a })
  expect(() => parseSurveyProfileView({ kind: 'default', profileId: a })).toThrow()
  expect(() => parseSurveyProfileView({ kind: 'profile', profileId: a, approved: true })).toThrow()
})
it('Profile filtering keeps the same complete mixed research in both environments and only their exact page references', () => {
  const f = fixture(), original = structuredClone(f.tab)
  const unknown = { regionId: 'missing-original-region', browserId: 'missing-original-browser' }
  for (const profileId of [a, b]) {
    const view = surveyProfileReferences({ kind: 'profile', profileId }, [...f.pages, unknown], ['whole-research', 'missing-research'], f.tabs, a, f.catalog)
    expect(view.pages).toEqual([f.pages[profileId === a ? 0 : 1], unknown])
    expect([...view.zoneIds]).toEqual(['whole-research', 'missing-research'])
  }
  expect(surveySelectionProfileMatch({ kind: 'profile', profileId: a }, { kind: 'page', ...f.pages[1]! }, f.tabs, a, f.catalog)).toBe('other')
  expect(surveySelectionProfileMatch({ kind: 'profile', profileId: a }, { zoneId: 'whole-research', selection: [], active: null }, f.tabs, a, f.catalog)).toBe('match')
  expect(f.tabs[f.tab.id]).toEqual(original)
})
it('an unread environment preference retains its original source and cannot abort other workface recovery', () => {
  const raw = { kind: 'future-original', source: 'retained' }, f = fixture()
  useAppStore.setState({ config, tabs: f.tabs, layouts: { resource: f.layout } })
  const restored = restorePersistedUiState(config, { surveyProfileView: raw, surveyPageReferences: f.pages })
  expect(restored.surveyProfileViewReadRecovery?.source).toBe(raw)
  expect(restored.surveyPageReferences).toEqual(f.pages)
  useAppStore.setState(restored)
  const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState()) as { surveyProfileView: unknown }
  expect(saved.surveyProfileView).toEqual(raw)
  expect(useAppStore.getState().tabs).toBe(f.tabs)
  expect(readSurveyProfileView(undefined).view).toEqual({ kind: 'default' })
})
it('the actual picker always offers default without directory IO and preserves an empty or unavailable explicit ID', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
  const onChange = vi.fn(), refresh = vi.fn()
  const profiles = { revision: null, sequence: null, profiles: null, folders: null, views: null, error: 'Directory ACK unavailable', reading: false }
  try {
    await act(async () => root.render(<SurveyProfilePicker value={{ kind: 'default' }} profiles={profiles} collapsed={false} onExpand={() => {}} onChange={onChange} onRefresh={refresh} />))
    const select = element.querySelector<HTMLSelectElement>('select[aria-label="Survey environment"]')!
    expect([...select.options].map(option => option.value)).toEqual(['default'])
    expect(select.disabled).toBe(false)
    expect(element.textContent).toContain('Default browsing is available')
    await act(async () => root.render(<SurveyProfilePicker value={{ kind: 'profile', profileId: b }} profiles={profiles} collapsed={false} onExpand={() => {}} onChange={onChange} onRefresh={refresh} />))
    expect(element.querySelector<HTMLSelectElement>('select')!.value).toBe('profile:' + b)
    expect(element.textContent).toContain('Unavailable environment')
    expect(onChange).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); element.remove() }
})
it('the one-default picker does not duplicate that environment or silently rewrite an explicit default ID', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element), changed = vi.fn()
  const profiles = { revision: 1, sequence: 1, profiles: [{ id: a, label: 'Personal', isDefault: true, createdAt: 1, source: null }], folders: [], views: [], error: null, reading: false }
  try {
    await act(async () => root.render(<SurveyProfilePicker value={{ kind: 'profile', profileId: a }} profiles={profiles} collapsed={false} onExpand={() => {}} onChange={changed} onRefresh={() => {}} />))
    const select = element.querySelector<HTMLSelectElement>('select')!
    expect([...select.options].map(option => option.value)).toEqual(['profile:' + a])
    expect(select.value).toBe('profile:' + a); expect(changed).not.toHaveBeenCalled()
    expect(select.title).toContain(a)
  } finally { await act(async () => root.unmount()); element.remove() }
})

it('the actual Survey requires an explicit choice for unread view while its default option stays reachable', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  browserProfiles.reset()
  vi.spyOn(api.browser, 'readProfiles').mockResolvedValue({ revision: 1, sequence: 1, profiles: [], folders: [], views: [] })
  const create = vi.fn(async () => { throw Error('Stop after the exact original creation port was reached') })
  useAppStore.setState({ config, surveyProfileView: { kind: 'default' }, surveyProfileViewReadRecovery: { source: { future: true }, issue: 'Original environment view unknown' },
    surveyPageReferences: [], surveyCollectedZones: {}, surveyZoneSelection: null, mainSurface: 'survey', createSurveyBrowser: create })
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
  try {
    await act(async () => root.render(<GlobalSurveySurface visible catalog={null} projection={null} selection={null} />))
    const button = element.querySelector<HTMLButtonElement>('[aria-label="New webpage"]')!
    expect(button).not.toBeNull()
    expect(element.querySelector<HTMLSelectElement>('[aria-label="Survey environment"]')!.value).toBe('unconfirmed')
    await act(async () => button.click())
    expect(create).not.toHaveBeenCalled()
    expect(element.textContent).toContain('Choose an environment')
    const select = element.querySelector<HTMLSelectElement>('[aria-label="Survey environment"]')!
    await act(async () => { select.value = 'default'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(useAppStore.getState().surveyProfileViewReadRecovery).toBeNull()
    await act(async () => button.click())
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ entry: 'page', preparation: null })
    expect(create.mock.calls[0]![0]).not.toHaveProperty('profileId')
  } finally { await act(async () => root.unmount()); element.remove() }
})
it('the actual Survey freezes A at New browser and a later B choice wins over its delayed creation result', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  browserProfiles.reset()
  const profile = (id: string) => ({ id, label: 'Same name', createdAt: 1, isDefault: false, source: null })
  vi.spyOn(api.browser, 'readProfiles').mockResolvedValue({ revision: 1, sequence: 1, profiles: [profile(a), profile(b)], folders: [], views: [] })
  let finish!: () => void
  const create = vi.fn(async (input: { profileId?: string }) => {
    await new Promise<void>(resolve => { finish = resolve })
    const state = useAppStore.getState(), f = fixture()
    useAppStore.setState({ tabs: f.tabs })
    return { zone: { zoneId: 'whole-research' }, reference: { displayWorkspaceId: 'resource', groupId: 'original-group', tabId: f.tab.id, regionId: 'region-a' },
      admission: { outcome: 'registered', issues: [] }, profileId: input.profileId, membership: state.surveyPageReferences }
  })
  useAppStore.setState({ config, surveyProfileView: { kind: 'profile', profileId: a }, surveyProfileViewReadRecovery: null,
    surveyPageReferences: [], surveyCollectedZones: {}, surveyZoneSelection: null, mainSurface: 'survey', createSurveyBrowser: create as never })
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
  try {
    await act(async () => root.render(<GlobalSurveySurface visible catalog={null} projection={null} selection={null} />))
    const button = element.querySelector<HTMLButtonElement>('[aria-label="New webpage"]')!
    await act(async () => button.click())
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ profileId: a })
    const select = element.querySelector<HTMLSelectElement>('[aria-label="Survey environment"]')!
    await act(async () => { select.value = 'profile:' + b; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => finish())
    expect(useAppStore.getState().surveyProfileView).toEqual({ kind: 'profile', profileId: b })
    expect(useAppStore.getState().surveyZoneSelection).toBeNull()
    expect(create).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()); element.remove() }
})

it.each([false, true])('Show original page uses the frozen exact binding without replay or reviving membership (replacement=%s)', async replacement => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  browserProfiles.reset()
  vi.spyOn(api.browser, 'readProfiles').mockResolvedValue({ revision: 1, sequence: 1, profiles: [], folders: [], views: [] })
  const createNative = vi.spyOn(api.browser, 'create'), switchNative = vi.spyOn(api.browser, 'switchProfile')
  const register = vi.fn(), f = fixture()
  const tab = { ...f.tab, space: { spaceId: 'original-space', zoneId: 'whole-research' } }
  let finish!: (value: { reason: string | null }) => void
  const save = vi.fn(async (view: { kind: 'profile'; profileId: string }) => {
    useAppStore.setState({ surveyProfileView: view })
    return await new Promise<{ reason: string | null }>(resolve => { finish = resolve })
  })
  const create = vi.fn(async (input: { onPrepared(value: unknown): void }) => {
    input.onPrepared({ zone: { zoneId: 'whole-research' }, reference: { tabId: tab.id, regionId: 'region-a' },
      createdBrowser: { id: 'browser-a', mode: 'normal', profileId: a }, admission: { outcome: 'unknown', issues: [{ code: 'SURVEY_PAGE_MEMBERSHIP_SUPERSEDED' }] } })
    throw new Error('Original membership was withdrawn while saving')
  })
  useAppStore.setState({ config, tabs: { [tab.id]: tab }, surveyProfileView: { kind: 'profile', profileId: b }, surveyProfileViewReadRecovery: null,
    surveyPageReferences: [], surveyCollectedZones: {}, surveyZoneSelection: null, mainSurface: 'survey', createSurveyBrowser: create as never,
    setSurveyProfileView: save as never, registerSurveyBrowserPage: register })
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
  try {
    await act(async () => root.render(<GlobalSurveySurface visible catalog={null} projection={null} selection={null} />))
    await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="New webpage"]')!.click())
    if (replacement) {
      const current = useAppStore.getState().tabs[tab.id]!
      await act(async () => useAppStore.setState({ tabs: { [tab.id]: { ...current, regions: { ...current.regions,
        'region-a': { ...current.regions['region-a']!, browserId: 'replacement-browser' } as never } } } }))
    }
    const show = [...element.querySelectorAll('button')].find(button => button.textContent === 'Show original page')!
    expect(show).toBeTruthy()
    await act(async () => show.click())
    expect(create).toHaveBeenCalledTimes(1)
    expect(createNative).not.toHaveBeenCalled(); expect(switchNative).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled()
    expect(useAppStore.getState().surveyPageReferences).toEqual([])
    if (replacement) {
      expect(save).not.toHaveBeenCalled(); expect(useAppStore.getState().surveyZoneSelection).toBeNull()
      expect(element.textContent).toContain('cannot select a replacement Browser')
    } else {
      expect(save).toHaveBeenCalledExactlyOnceWith({ kind: 'profile', profileId: a })
      expect(useAppStore.getState().surveyZoneSelection).toEqual({ kind: 'page', regionId: 'region-a', browserId: 'browser-a' })
      const later = { kind: 'page' as const, regionId: 'region-b', browserId: 'browser-b' }
      await act(async () => { useAppStore.setState({ surveyProfileView: { kind: 'profile', profileId: b }, surveyZoneSelection: later }); finish({ reason: 'Old preference ACK unconfirmed' }) })
      expect(useAppStore.getState().surveyZoneSelection).toBe(later)
      expect(useAppStore.getState().surveyProfileView).toEqual({ kind: 'profile', profileId: b })
      expect(element.textContent).not.toContain('Old preference ACK unconfirmed')
    }
  } finally { await act(async () => root.unmount()); element.remove() }
})

it('clearing an incompatible Survey page keeps the environment select focused for continued keyboard input', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  browserProfiles.reset()
  const f = fixture()
  const profile = (id: string) => ({ id, label: 'Same name', createdAt: 1, isDefault: false, source: null })
  vi.spyOn(api.browser, 'readProfiles').mockResolvedValue({ revision: 1, sequence: 1, profiles: [profile(a), profile(b)], folders: [], views: [] })
  const create = vi.spyOn(api.browser, 'create'), switchProfile = vi.spyOn(api.browser, 'switchProfile')
  useAppStore.setState({ config, tabs: f.tabs, layouts: { resource: f.layout }, surveyProfileView: { kind: 'profile', profileId: a }, surveyProfileViewReadRecovery: null,
    surveyPageReferences: f.pages, surveyCollectedZones: {}, surveyZoneSelection: { kind: 'page', ...f.pages[0]! }, mainSurface: 'survey' })
  function CurrentSurvey() {
    const selected = useAppStore(state => state.surveyZoneSelection)
    return <GlobalSurveySurface visible catalog={f.catalog} projection={null} selection={null} pageSelection={selected && 'kind' in selected && selected.kind === 'page' ? selected : null} />
  }
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
  try {
    await act(async () => root.render(<CurrentSurvey />))
    const select = element.querySelector<HTMLSelectElement>('[aria-label="Survey environment"]')!
    select.focus()
    expect(document.activeElement).toBe(select)
    await act(async () => { select.value = 'profile:' + b; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(useAppStore.getState().surveyZoneSelection).toBeNull()
    expect(useAppStore.getState().surveyProfileView).toEqual({ kind: 'profile', profileId: b })
    expect(document.activeElement).toBe(select)
    // A following environment choice still belongs to that control, with no
    // repeated focus call and no input escaping into the new start-page field.
    await act(async () => { select.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', bubbles: true })); select.value = 'profile:' + a; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(document.activeElement).toBe(select)
    expect(useAppStore.getState().surveyProfileView).toEqual({ kind: 'profile', profileId: a })
    expect(element.querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')!.value).toBe('')
    expect(create).not.toHaveBeenCalled(); expect(switchProfile).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); element.remove() }
})
