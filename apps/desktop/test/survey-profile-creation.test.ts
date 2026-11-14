// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { api } from '../src/renderer/src/lib/api'
import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { useAppStore } from '../src/renderer/src/store'
import { startWorkfaceFixture, regionIdA, tabId } from './helpers/workface-control-fixture'
const initial = useAppStore.getState()
let fixture: Awaited<ReturnType<typeof startWorkfaceFixture>>
let create: ReturnType<typeof vi.spyOn>, switchProfile: ReturnType<typeof vi.spyOn>, close: ReturnType<typeof vi.spyOn>
const defaultId = '11111111-1111-4111-8111-111111111111', a = '22222222-2222-4222-8222-222222222222', b = '33333333-3333-4333-8333-333333333333'
const snapshot = (id: string, profileId = defaultId, mode: 'normal' | 'private' = 'normal', url = 'https://generic.invalid/') => ({
  id, url, title: 'Original page', mode, profileId: mode === 'private' ? null : profileId, navigationId: id + '-navigation',
  canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive' as const, error: null, driving: false, appLinkPrompt: null
})
beforeEach(async () => {
  vi.restoreAllMocks(); browserProfiles.reset(); localStorage.clear(); useAppStore.setState(initial, true)
  fixture = await startWorkfaceFixture()
  useAppStore.setState({ surveyPageReferences: [], surveyCollectedZones: {}, surveyPageReadRecovery: null, surveyProfileView: { kind: 'default' } })
  create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url, _workspace, profileId, mode) => snapshot(id, profileId, mode, url))
  close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  switchProfile = vi.spyOn(api.browser, 'switchProfile').mockImplementation(async (id, target) => ({ ...snapshot(id, target), navigationId: id + '-new-profile' }))
})
afterEach(async () => {
  await fixture?.stop(); if (fixture) await rm(fixture.directory, { recursive: true, force: true })
  vi.restoreAllMocks(); browserProfiles.reset(); useAppStore.setState(initial, true)
})
const prepare = (profileId?: string, mode?: 'private') => useAppStore.getState().createSurveyBrowser({ workspaceId: 'resource', url: 'https://generic.invalid/original',
  ...(profileId === undefined ? {} : { profileId }), ...(mode ? { mode } : {}), preparation: null, onPrepared() {} })

it.each([{ name: 'default', profileId: undefined }, { name: 'named', profileId: a }, { name: 'private', profileId: undefined, mode: 'private' as const }])(
  'one ordinary $name creation produces one exact page entrance without collecting its resource Zone', async ({ profileId, mode }) => {
    const result = await prepare(profileId, mode)
    const surface = useAppStore.getState().tabs[result.reference.tabId]!.regions[result.reference.regionId]!
    expect(surface).toMatchObject({ kind: 'browser', browserId: result.createdBrowser!.id })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![3]).toBe(profileId)
    expect(useAppStore.getState().surveyCollectedZones).toEqual({})
    expect(useAppStore.getState().surveyPageReferences).toEqual([{ regionId: result.reference.regionId, browserId: result.createdBrowser!.id }])
    expect(result.admission?.outcome).toBe('registered')
    expect(close).not.toHaveBeenCalled()
  })

it('a failed save retries only the frozen original page/profile/address and keeps a later filter selection', async () => {
  fixture.flush.mockRejectedValue(Error('Injected preference ACK failure'))
  const result = await prepare(a)
  expect(result.admission?.outcome).toBe('partial')
  fixture.flush.mockResolvedValue(undefined)
  useAppStore.setState({ surveyProfileView: { kind: 'profile', profileId: b } })
  const retried = await useAppStore.getState().createSurveyBrowser({ workspaceId: 'resource', url: 'https://alternate.invalid/replacement', profileId: b,
    preparation: result, onPrepared() {} })
  expect(retried.createdBrowser).toEqual(result.createdBrowser)
  expect(retried.profileId).toBe(a); expect(retried.url).toBe('https://generic.invalid/original')
  expect(create).toHaveBeenCalledTimes(1); expect(switchProfile).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  expect(useAppStore.getState().surveyProfileView).toEqual({ kind: 'profile', profileId: b })
})

it.each(['page', 'research'] as const)('a replacement Browser in the same prepared Region cannot be adopted by Retry (%s)', async entry => {
  const result = await useAppStore.getState().createSurveyBrowser({ workspaceId: 'resource', url: 'about:blank', profileId: a, entry, preparation: null, onPrepared() {} }), state = useAppStore.getState(), tab = state.tabs[result.reference.tabId]!
  useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
    [result.reference.regionId]: { ...snapshot('different-replacement-browser', a), kind: 'browser', browserId: 'different-replacement-browser',
      regionId: result.reference.regionId, workspaceId: 'resource' }
  } } } })
  const pages = useAppStore.getState().surveyPageReferences
  await expect(useAppStore.getState().createSurveyBrowser({ workspaceId: 'resource', url: 'about:blank', profileId: b, preparation: result, onPrepared() {} })).rejects.toThrow('Another Browser')
  expect(create).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled()
  expect(useAppStore.getState().surveyPageReferences).toBe(pages)
  expect(useAppStore.getState().tabs[tab.id]!.regions[result.reference.regionId]).toMatchObject({ browserId: 'different-replacement-browser' })
})

async function originalBoundPage() {
  const before = useAppStore.getState(), tab = before.tabs[tabId]!
  useAppStore.setState({ tabs: { ...before.tabs, [tabId]: { ...tab, regions: { ...tab.regions, [regionIdA]: {
    ...snapshot('original-bound-browser', a), regionId: regionIdA, browserId: 'original-bound-browser', kind: 'browser', workspaceId: 'resource'
  } } } } })
  return { regionId: regionIdA, browserId: 'original-bound-browser' }
}
it('a confirmed person binding with failed membership save retries only metadata and never switches Native twice', async () => {
  const reference = await originalBoundPage()
  fixture.flush.mockRejectedValue(Error('Injected preference ACK failure'))
  const bound = await useAppStore.getState().switchBrowserProfileForSurvey(reference, b)
  expect(bound).toMatchObject({ reference, profileId: b, admission: { outcome: 'partial' } })
  fixture.flush.mockResolvedValue(undefined)
  const repaired = await useAppStore.getState().repairSurveyProfileAdmission(bound)
  expect(repaired.admission.outcome).toBe('registered')
  expect(switchProfile).toHaveBeenCalledExactlyOnceWith(reference.browserId, b)
  expect(create).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
})
it('a late binding save ACK cannot absorb a subsequent removal generation or resurrect it on metadata Retry', async () => {
  const reference = await originalBoundPage()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  fixture.flush.mockImplementation(() => gate)
  const pending = useAppStore.getState().switchBrowserProfileForSurvey(reference, b)
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toEqual([reference]))
  const applied = useAppStore.getState().surveyPageReferences
  const removing = useAppStore.getState().setSurveyPageCollected(reference, false)
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
  finish()
  const bound = await pending; await removing
  expect(bound.membership).toBe(applied)
  expect(bound.admission.issues[0]?.code).toBe('SURVEY_PAGE_MEMBERSHIP_SUPERSEDED')
  const after = useAppStore.getState().surveyPageReferences
  const retry = await useAppStore.getState().repairSurveyProfileAdmission(bound)
  expect(retry.admission.issues[0]?.code).toBe('SURVEY_PAGE_MEMBERSHIP_SUPERSEDED')
  expect(useAppStore.getState().surveyPageReferences).toBe(after)
  expect(switchProfile).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
})
it('remove/add/remove during Main binding is a newer membership intent even when its final values equal the initial set', async () => {
  const reference = await originalBoundPage()
  let finish!: () => void
  switchProfile.mockImplementationOnce(async (id: string, target: string) => { await new Promise<void>(resolve => { finish = resolve }); return snapshot(id, target) })
  const pending = useAppStore.getState().switchBrowserProfileForSurvey(reference, b)
  await useAppStore.getState().setSurveyPageCollected(reference, true)
  await useAppStore.getState().setSurveyPageCollected(reference, false)
  finish(); const bound = await pending
  expect(bound.admission.issues[0]?.code).toBe('SURVEY_PAGE_MEMBERSHIP_SUPERSEDED')
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
  expect(switchProfile).toHaveBeenCalledTimes(1)
})

it('an explicit research child also requires the frozen Main Profile while preserving a mismatched healthy page and original Zone', async () => {
  create.mockImplementationOnce(async (id: string, url: string) => snapshot(id, b, 'normal', url))
  await expect(useAppStore.getState().createSurveyBrowser({ workspaceId: 'resource', url: 'https://generic.invalid/research',
    profileId: a, entry: 'research', preparation: null, onPrepared() {} })).rejects.toThrow('frozen environment')
  expect(create).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled()
  expect(Object.keys(useAppStore.getState().surveyCollectedZones)).toHaveLength(1)
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
  expect(Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).filter(surface => surface.kind === 'browser'))
    .toEqual([expect.objectContaining({ profileId: b })])
})

it('a lost switch ACK after an exact Main updated event offers metadata-only repair without replaying the switch', async () => {
  const reference = await originalBoundPage()
  switchProfile.mockImplementationOnce(async (id: string, target: string) => {
    useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...snapshot(id, target), navigationId: 'actual-Main-updated-before-lost-ACK' } })
    throw Error('Main switch reply unavailable')
  })
  const pending = useAppStore.getState().switchBrowserProfileForSurvey(reference, b)
  await expect(pending).resolves.toMatchObject({ switchOutcome: 'unconfirmed' })
  const binding = await pending
  expect(binding.switchOutcome).toBe('unconfirmed')
  expect(binding.admission.issues[0]?.code).toBe('BROWSER_PROFILE_SWITCH_UNCONFIRMED')
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
  const repaired = await useAppStore.getState().repairSurveyProfileAdmission(binding)
  expect(repaired.switchOutcome).toBe('unconfirmed')
  expect(repaired.admission.outcome).toBe('registered')
  expect(useAppStore.getState().surveyPageReferences).toEqual([reference])
  expect(switchProfile).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
})
it('the actual view owner clears only an incompatible Survey selection and exposes the same preference through compiled public presentation', async () => {
  const reference = await originalBoundPage()
  useAppStore.setState({ surveyPageReferences: [reference], surveyZoneSelection: { kind: 'page', ...reference }, mainSurface: 'survey' })
  const before = useAppStore.getState()
  await before.setSurveyProfileView({ kind: 'profile', profileId: b })
  expect(useAppStore.getState().surveyZoneSelection).toBeNull()
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().surveyPageReferences).toBe(before.surveyPageReferences)
  const presentation = await fixture.run('space.ls', ['space', 'ls', '--presentation'])
  expect(presentation.catalog.survey?.profileView).toEqual({ kind: 'profile', profileId: b })
  expect(create).not.toHaveBeenCalled(); expect(switchProfile).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
})

it('a missing ACK before the later Main update retains the original membership generation across remove/add/remove and metadata repair', async () => {
  const reference = await originalBoundPage(), original = useAppStore.getState().surveyPageReferences
  let fail!: (error: Error) => void
  switchProfile.mockImplementationOnce(async () => await new Promise((_resolve, reject) => { fail = reject }))
  const pending = useAppStore.getState().switchBrowserProfileForSurvey(reference, b)
  await useAppStore.getState().setSurveyPageCollected(reference, true)
  await useAppStore.getState().setSurveyPageCollected(reference, false)
  fail(Error('Switch reply lost before the original Main updated event'))
  const receipt = await pending
  expect(receipt.switchOutcome).toBe('unconfirmed')
  expect(receipt.membership).toBe(original)
  expect(useAppStore.getState().tabs[tabId]!.regions[regionIdA]).toMatchObject({ profileId: a })
  useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...snapshot(reference.browserId, b), navigationId: 'later-exact-Main-update' } })
  const repaired = await useAppStore.getState().repairSurveyProfileAdmission(receipt)
  expect(repaired.admission.issues[0]?.code).toBe('SURVEY_PAGE_MEMBERSHIP_SUPERSEDED')
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
  expect(switchProfile).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
})
