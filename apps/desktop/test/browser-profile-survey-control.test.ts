// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { AgentMuxControlServer, parseAgentMuxControlReceipt } from '@agentmux/core'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { useAppStore } from '../src/renderer/src/store'
import { startWorkfaceFixture, tabId, regionIdA, regionIdC } from './helpers/workface-control-fixture'

const initial = useAppStore.getState()
let fixture: Awaited<ReturnType<typeof startWorkfaceFixture>>
let create: ReturnType<typeof vi.spyOn>, close: ReturnType<typeof vi.spyOn>
const profileOne = '11111111-1111-4111-8111-111111111111'
const profileTwo = '22222222-2222-4222-8222-222222222222'

beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); browserProfiles.reset(); useAppStore.setState(initial, true)
  fixture = await startWorkfaceFixture()
  useAppStore.setState({ surveyPageReferences: [], surveyPageReadRecovery: null, surveyCollectedZones: {} })
  create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url = 'about:blank', _workspace, profileId, mode = 'normal', _referrer, capsuleId) => ({
    id, url, title: 'Original Profile page', profileId: mode === 'private' || capsuleId ? null : profileId ?? profileOne, mode,
    canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive', navigationId: 'actual-main-navigation',
    error: null, driving: false, appLinkPrompt: null
  }))
  close = vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'listProfiles').mockResolvedValue([
    { id: profileOne, label: 'Default environment', createdAt: 1, source: null, isDefault: true },
    { id: profileTwo, label: 'Work environment', createdAt: 2, source: null, isDefault: false }
  ])
})
afterEach(async () => {
  await fixture?.stop(); if (fixture) await rm(fixture.directory, { recursive: true, force: true })
  vi.restoreAllMocks(); browserProfiles.reset(); useAppStore.setState(initial, true)
})
const open = (profileId?: string, extra = {}) => useAppStore.getState().executeControl({
  schemaVersion: 5, requestId: 'explicit-original-open', operation: 'open.browser', url: 'https://generic.invalid/profile',
  destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: regionIdA } },
  ...(profileId ? { profileId } : {}), ...extra
})

it.each([{}, { mode: 'private' as const }, { capsuleId: 'AbCdEfGh1234' }])('[survey-cli] explicit Survey admission saves only the original default/private/Capsule page (%j)', async extra => {
  const before = useAppStore.getState(), siblings = { ...before.tabs[tabId]!.regions }
  const result = await open(undefined, { ...extra, survey: true })
  if (result.operation !== 'open.browser') throw Error('Original Browser open result required')
  expect(result.survey).toMatchObject({ outcome: 'registered', reference: { regionId: result.region.regionId, browserId: result.region.browserId } })
  expect(useAppStore.getState().surveyPageReferences).toEqual([result.survey.reference])
  expect(useAppStore.getState().surveyCollectedZones).toEqual({})
  for (const [id, surface] of Object.entries(siblings)) expect(useAppStore.getState().tabs[tabId]!.regions[id]).toBe(surface)
  expect(useAppStore.getState().mainSurface).toBe(before.mainSurface)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(create).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
})

it('[survey-cli] explicit default registration save failure retains the same available page and repair edits only its reference', async () => {
  fixture.flush.mockRejectedValue(Error('Exact Survey preference ACK unavailable'))
  const result = await open(undefined, { survey: true })
  if (result.operation !== 'open.browser') throw Error('Original Browser open result required')
  expect(result.survey.outcome).toBe('partial')
  const browser = useAppStore.getState().tabs[result.region.tabId]!.regions[result.region.regionId]
  fixture.flush.mockResolvedValue(undefined)
  const repaired = await useAppStore.getState().setSurveyPageCollected(result.survey.reference!, true)
  expect(repaired.outcome).toBe('unchanged')
  expect(repaired.save?.storageFlushRequested).toBe(true)
  expect(useAppStore.getState().tabs[result.region.tabId]!.regions[result.region.regionId]).toBe(browser)
  expect(create).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
})

it('[survey-cli] a later explicit withdrawal during default creation is not resurrected by admission', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  fixture.flush.mockImplementation(() => gate)
  const opening = open(undefined, { survey: true })
  await vi.waitFor(() => expect(useAppStore.getState().surveyPageReferences).toHaveLength(1))
  const reference = useAppStore.getState().surveyPageReferences[0]!
  const removal = useAppStore.getState().setSurveyPageCollected(reference, false)
  release()
  const result = await opening; await removal
  if (result.operation !== 'open.browser') throw Error('Original Browser open result required')
  expect(result.survey.outcome).toBe('unknown')
  expect(result.survey.issues.some(issue => issue.code === 'SURVEY_PAGE_MEMBERSHIP_SUPERSEDED')).toBe(true)
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
  expect(create).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
})

it('explicit Profile creation registers only the exact Main-confirmed Browser/Region and retains mixed task siblings and navigation', async () => {
  const before = useAppStore.getState(), siblings = { ...before.tabs[tabId]!.regions }
  const result = await open(profileTwo)
  if (result.operation !== 'open.browser') throw Error('Original Browser open result required')
  expect(result.region.profileId).toBe(profileTwo)
  expect(result.region.browserId).not.toBe(result.region.regionId)
  expect(result.survey).toMatchObject({ outcome: 'registered', reference: { regionId: result.region.regionId, browserId: result.region.browserId } })
  expect(result.survey.save?.diskDurability).toBe('unconfirmed')
  const after = useAppStore.getState()
  expect(after.surveyPageReferences).toEqual([result.survey.reference]); expect(after.surveyCollectedZones).toEqual({})
  for (const [id, surface] of Object.entries(siblings)) expect(after.tabs[tabId]!.regions[id]).toBe(surface)
  expect([after.sessions, after.documents, after.dirtyDocuments, after.agentComposerDrafts, after.mainSurface, after.activeWorkspaceId, after.workbenchSpaceSelection])
    .toEqual([before.sessions, before.documents, before.dirtyDocuments, before.agentComposerDrafts, before.mainSurface, before.activeWorkspaceId, before.workbenchSpaceSelection])
  expect(close).not.toHaveBeenCalled()
})

it('default, private and Capsule creation do not infer Survey intent from a returned Profile or restore/discovery', async () => {
  for (const extra of [{}, { mode: 'private' as const }, { capsuleId: 'AbCdEfGh1234' }]) {
    const result = await open(undefined, extra)
    if (result.operation !== 'open.browser') throw Error('Original Browser open result required')
    expect(result.survey).toEqual({ outcome: 'not-requested', save: null, issues: [] })
  }
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
  await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'read-only', operation: 'space.ls', target: {} })
  expect(useAppStore.getState().surveyPageReferences).toEqual([]); expect(close).not.toHaveBeenCalled()
})

it('a failed Survey preference save returns partial and keeps the attached original page without cleanup or another creation', async () => {
  fixture.flush.mockRejectedValue(Error('Injected exact preference write failure'))
  const result = await open(profileTwo)
  if (result.operation !== 'open.browser') throw Error('Original Browser open result required')
  expect(result.survey.outcome).toBe('partial'); expect(result.survey.issues[0]?.step).toBe('save')
  expect(useAppStore.getState().tabs[result.region.tabId]!.regions[result.region.regionId]).toMatchObject({ kind: 'browser', browserId: result.region.browserId })
  expect(close).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledTimes(1)
  const list = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'read-original', operation: 'space.survey-list' })
  expect(list).toMatchObject({ pageReferences: [result.survey.reference] }); expect(create).toHaveBeenCalledTimes(1)
})

it('an unavailable Profile label after native creation retains the actual Profile ID, attached page, reference and explicit service issue', async () => {
  vi.mocked(api.browser.listProfiles).mockRejectedValueOnce(Error('Profile directory observation unavailable'))
  const opening = open(profileTwo)
  await expect(opening).resolves.toMatchObject({ operation: 'open.browser' })
  const result = await opening
  if (result.operation !== 'open.browser') throw Error('Original Browser open result required')
  expect(result.region).toMatchObject({ profileId: profileTwo, profileIssue: expect.stringContaining('label is unconfirmed') })
  expect(result.survey.reference).toEqual({ regionId: result.region.regionId, browserId: result.region.browserId })
  expect(useAppStore.getState().tabs[result.region.tabId]!.regions[result.region.regionId]).toMatchObject({ browserId: result.region.browserId, profileId: profileTwo })
  expect(close).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledTimes(1)
})

it('unreadable Survey membership declines only its registration while an accurately created page and existing work remain available', async () => {
  useAppStore.setState({ surveyPageReadRecovery: { source: { unknown: 'retained' }, issue: 'The original page preference is unreadable.' } })
  const result = await open(profileTwo)
  if (result.operation !== 'open.browser') throw Error('Original Browser open result required')
  expect(result.survey.outcome).toBe('unknown'); expect(result.survey.issues[0]?.code).toBe('SURVEY_PAGE_PREFERENCES_UNREADABLE')
  expect(useAppStore.getState().tabs[result.region.tabId]!.regions[result.region.regionId]).toMatchObject({ browserId: result.region.browserId })
  expect(close).not.toHaveBeenCalled()
})

it('a foreign Browser reply is rejected without granting cleanup authority over that other original Browser', async () => {
  create.mockImplementationOnce(async () => ({
    id: 'another-original-browser', url: 'https://alternate.invalid/original', title: 'Unrelated original', profileId: profileTwo, mode: 'normal',
    canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive', navigationId: 'unrelated-document', error: null, driving: false, appLinkPrompt: null
  }))
  await expect(open(profileTwo)).rejects.toMatchObject({ code: 'LAUNCH_RESULT_MISMATCH' })
  expect(close).not.toHaveBeenCalled()
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
})

it('GUI reattachment preserves the Main retained Profile and refuses only a mismatched requested Profile registration', async () => {
  create.mockImplementationOnce(async (id: string, url: string) => ({
    id, url, title: 'Original retained Profile', profileId: profileOne, mode: 'normal', canGoBack: false, canGoForward: false,
    loading: false, viewport: 'responsive', navigationId: 'retained-document', error: null, driving: false, appLinkPrompt: null
  }))
  const warning = vi.spyOn(useAppStore.getState(), 'reportError')
  await useAppStore.getState().createBrowser('resource-group', undefined, 'https://generic.invalid/retained', undefined, 'resource', undefined, 'normal', undefined, profileTwo)
  expect(useAppStore.getState().surveyPageReferences).toEqual([])
  const browser = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).find(surface => surface.kind === 'browser')
  expect(browser).toMatchObject({ kind: 'browser', profileId: profileOne })
  expect(close).not.toHaveBeenCalled(); expect(warning).toHaveBeenCalled()
})

it('actual compiled CLI creates in two exact Profiles, reads original page membership and reports label-read failure without losing the page', async () => {
  const first = await fixture.run('browser.open', ['browser', 'open', '--url', 'https://generic.invalid/one', '--profile', profileOne, '--right-of', regionIdA])
  const second = await fixture.run('browser.open', ['browser', 'open', '--url', 'https://alternate.invalid/two', '--profile', profileTwo, '--right-of', regionIdA])
  expect(first.region.profileId).toBe(profileOne); expect(second.region.profileId).toBe(profileTwo)
  const list = await fixture.run('space.survey-list', ['space', 'survey-list'])
  expect(list.collectedZoneIds).toEqual([]); expect(list.pageReferences).toEqual([first.survey.reference, second.survey.reference])
  vi.mocked(api.browser.listProfiles).mockRejectedValueOnce(Error('Original Profile directory read failed'))
  const unknownLabel = await fixture.run('browser.open', ['browser', 'open', '--url', 'https://generic.invalid/label', '--profile', profileTwo, '--right-of', regionIdA])
  expect(unknownLabel.region.profileId).toBe(profileTwo); expect(unknownLabel.region.profileIssue).toContain('label is unconfirmed')
  expect(close).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledTimes(3)
}, 60_000)

it.each(['Profile', 'Browser identity'] as const)('compiled CLI retains actual Main identities through Renderer, native Control bridge and RPC after a %s mismatch without closing the original page', async mismatch => {
  create.mockImplementationOnce(async (id: string, url: string) => ({
    id: mismatch === 'Profile' ? id : 'unrelated-original-browser', url, title: 'Original retained Profile', profileId: profileOne, mode: 'normal',
    canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive',
    navigationId: 'retained-original-document', error: null, driving: false, appLinkPrompt: null
  }))
  type Preload = AgentMuxPreloadApi['control']
  let requestListener!: Parameters<Preload['onRequest']>[0]
  let cancellationListener!: Parameters<Preload['onCancellation']>[0]
  const bridge = new DesktopControlIpcBridge({
    isAvailable: () => true,
    sendRequest: request => requestListener(request),
    sendCancellation: cancellation => cancellationListener(cancellation)
  })
  const renderer = createRendererControlApi({
    onRequest: listener => { requestListener = listener; return () => {} },
    onCancellation: listener => { cancellationListener = listener; return () => {} },
    respond: response => { bridge.accept(response) }
  })
  const disposeRenderer = renderer.onRequest(request => useAppStore.getState().executeControl(request))
  const directory = await mkdtemp(join(fixture.directory, 'bridge-'))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), execute: request => bridge.execute(request) })
  await server.start()
  const before = useAppStore.getState()
  try {
    const failure = await promisify(execFile)(process.execPath, [join(process.cwd(), 'packages/core/bin/amux'),
      'browser', 'open', '--url', 'https://generic.invalid/retained', '--profile', profileTwo,
      '--right-of', regionIdA, '--operation-id', 'original-profile-mismatch'], {
      env: { ...fixture.env, AGENTMUX_RUNTIME_DIRECTORY: directory }, timeout: 8_000
    }).then(() => { throw Error('Expected the original Profile mismatch receipt') }, error => error)
    expect(failure.code).toBe(1)
    const receipt = JSON.parse(failure.stderr.trim())
    const actualBrowserId = create.mock.calls[0]![0]
    const expectedDetails = mismatch === 'Profile' ? {
      kind: 'browser-open-profile-mismatch', operationId: 'original-profile-mismatch', browserId: actualBrowserId,
      profileId: profileOne, requestedProfileId: profileTwo, mode: 'normal'
    } : {
      kind: 'browser-open-identity-mismatch', operationId: 'original-profile-mismatch',
      requestedBrowserId: actualBrowserId, returnedBrowserId: 'unrelated-original-browser', creation: 'unconfirmed'
    }
    expect(receipt).toMatchObject({ ok: false, operation: 'browser.open', operationId: 'original-profile-mismatch', error: {
      code: 'LAUNCH_RESULT_MISMATCH', details: expectedDetails
    } })
    // The retained Main page is not this request's cleanup resource. The mixed
    // workface and original Launcher remain exactly as before the refused binding.
    expect(close).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs).toEqual(before.tabs)
    expect(useAppStore.getState().surveyPageReferences).toEqual([])
    const wire = { schemaVersion: 5, requestId: 'original-profile-mismatch', operation: 'open.browser', ok: false,
      error: { code: receipt.error.code, message: receipt.error.message, details: receipt.error.details } }
    expect(parseAgentMuxControlReceipt(wire)).toMatchObject(wire)
    const unrelatedDetails = { kind: 'terminal-original-failure', opaqueOriginalId: 'terminal-op' }
    expect(parseAgentMuxControlReceipt({ ...wire, error: { code: 'LAUNCH_RESULT_MISMATCH', message: 'Original Terminal failure', details: unrelatedDetails } }))
      .toMatchObject({ error: { details: unrelatedDetails } })
    const invalidDetails = mismatch === 'Profile'
      ? { ...wire.error.details, profileId: profileTwo }
      : { ...wire.error.details, returnedBrowserId: actualBrowserId }
    expect(() => parseAgentMuxControlReceipt({ ...wire, error: { ...wire.error, details: invalidDetails } })).toThrow()
  } finally {
    disposeRenderer(); bridge.dispose(); await server.stop()
  }
}, 60_000)

it('a Profile mismatch during unrelated Browser metadata and input updates restores only its planned split geometry and preserves the newer original content', async () => {
  const state = useAppStore.getState(), originalTab = state.tabs[tabId]!
  useAppStore.setState({ tabs: { ...state.tabs, [tabId]: { ...originalTab, regions: { ...originalTab.regions,
    [regionIdC]: { regionId: regionIdC, workspaceId: 'resource', kind: 'browser', browserId: 'retained-sibling-browser',
      url: 'https://alternate.invalid/original', title: 'Original title', mode: 'normal', profileId: profileOne,
      canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive', navigationId: 'original-sibling-document',
      error: null, driving: false, appLinkPrompt: null }
  } } } })
  const before = useAppStore.getState()
  create.mockImplementationOnce(async (id: string, url: string) => {
    const pending = useAppStore.getState(), tab = pending.tabs[tabId]!
    useAppStore.setState({ tabs: { ...pending.tabs, [tabId]: { ...tab, regions: { ...tab.regions,
      [regionIdC]: { ...tab.regions[regionIdC]!, title: 'New native background title' } as never
    } } }, agentComposerDrafts: { ...pending.agentComposerDrafts, 'original-pending-input': 'New unsent input during Main create' } })
    return { id, url, title: 'Original mismatched page', profileId: profileOne, mode: 'normal', canGoBack: false,
      canGoForward: false, loading: false, viewport: 'responsive', navigationId: 'retained-document',
      error: null, driving: false, appLinkPrompt: null }
  })
  await expect(open(profileTwo)).rejects.toMatchObject({ code: 'LAUNCH_RESULT_MISMATCH' })
  const after = useAppStore.getState()
  expect(after.tabs[tabId]!.layout).toEqual(before.tabs[tabId]!.layout)
  expect(Object.keys(after.tabs[tabId]!.regions)).toEqual(Object.keys(before.tabs[tabId]!.regions))
  expect(after.tabs[tabId]!.regions[regionIdC]).toMatchObject({ browserId: 'retained-sibling-browser', title: 'New native background title' })
  expect(after.agentComposerDrafts['original-pending-input']).toBe('New unsent input during Main create')
  expect(close).not.toHaveBeenCalled()
})

it('a later explicit layout change wins over the captured Browser split rollback', async () => {
  const before = useAppStore.getState()
  create.mockImplementationOnce(async (id: string, url: string) => {
    const pending = useAppStore.getState(), tab = pending.tabs[tabId]!
    if (tab.layout.root.type !== 'split') throw Error('The original mixed Tab must remain split')
    useAppStore.setState({ tabs: { ...pending.tabs, [tabId]: { ...tab,
      layout: { ...tab.layout, root: { ...tab.layout.root, ratio: 0.72 } }
    } } })
    return { id, url, title: 'Original mismatched page', profileId: profileOne, mode: 'normal', canGoBack: false,
      canGoForward: false, loading: false, viewport: 'responsive', navigationId: 'retained-document',
      error: null, driving: false, appLinkPrompt: null }
  })
  await expect(open(profileTwo)).rejects.toMatchObject({ code: 'LAUNCH_RESULT_MISMATCH' })
  const after = useAppStore.getState()
  expect(after.tabs[tabId]!.layout.root).toMatchObject({ type: 'split', ratio: 0.72 })
  expect(Object.keys(after.tabs[tabId]!.regions)).toEqual(Object.keys(before.tabs[tabId]!.regions))
  expect(close).not.toHaveBeenCalled()
})
