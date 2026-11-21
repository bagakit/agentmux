// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, checkpointSpatialWorkbench } from '../src/renderer/src/store'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { desktopUserFragments } from '../src/renderer/src/lib/desktop-user-state'
import { openSystemUrlInSurvey } from '../src/renderer/src/lib/survey-system-url'
import { WebUrlIngress } from '../src/main/web-url-ingress'
import { planSpatialZone } from '../src/renderer/src/lib/space-agent-control'
import { startWorkfaceFixture, tabId } from './helpers/workface-control-fixture'

const initial = useAppStore.getState()
let fixture: Awaited<ReturnType<typeof startWorkfaceFixture>>
const defaultId = '11111111-1111-4111-8111-111111111111'
const snapshot = (id: string, url: string) => ({ id, url, title: 'Original system page', mode: 'normal' as const, profileId: defaultId,
  navigationId: id + '-native-navigation', canGoBack: false, canGoForward: false, loading: true,
  viewport: 'responsive' as const, error: null, driving: false, appLinkPrompt: null })
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
function receipt(caseName: string, value: object) {
  if (process.env.SYSTEM_OPEN_RECEIPT) appendFileSync(process.env.SYSTEM_OPEN_RECEIPT, JSON.stringify({ case: caseName, ...value }) + '\n')
}
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(initial, true)
  fixture = await startWorkfaceFixture()
  const before = useAppStore.getState(), workspace = { ...before.config!.workspaces[0]!, id: SCRATCH_WORKSPACE_ID, name: 'Private system Scratch', path: fixture.directory + '/scratch' }
  useAppStore.setState({ config: { ...before.config!, workspaces: [...before.config!.workspaces, workspace] },
    layouts: { ...before.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('system-group') },
    surveyPageReferences: [], surveyPageReadRecovery: null, surveyCollectedZones: {}, surveyProfileView: { kind: 'default' } })
  await checkpointSpatialWorkbench()
})
afterEach(async () => {
  await fixture?.stop(); if (fixture) await rm(fixture.directory, { recursive: true, force: true })
  vi.restoreAllMocks(); useAppStore.setState(initial, true)
})
function system() {
  let input = 0
  const host = { get: useAppStore.getState, navigation: () => JSON.stringify([input, useAppStore.getState().mainSurface, useAppStore.getState().surveyZoneSelection]),
    subscribe: (listener: () => void) => useAppStore.subscribe(listener) }
  const ingress = new WebUrlIngress(), outcomes: any[] = [], issues: string[] = []
  ingress.ready(async (request, signal) => { const outcome = await openSystemUrlInSurvey(host, request, signal); outcomes.push(outcome); return outcome }, issue => issues.push(issue))
  return { ingress, outcomes, issues, navigate() { input++; useAppStore.getState().setMainSurface('board') } }
}

it('system-open: preparing a Survey Zone leaves unrelated Region projection out of address opening', () => {
  const state = useAppStore.getState(), tab = state.tabs[tabId]!
  const readRegions = vi.fn(() => tab.regions)
  const tabs = { ...state.tabs, [tabId]: { ...tab, get regions() { return readRegions() } } }
  const planned = planSpatialZone({ ...state, tabs }, [], { workspaceId: SCRATCH_WORKSPACE_ID, zoneId: 'new-zone-for-original-url', spaceIds: [] })
  expect(planned.zone).toMatchObject({ zoneId: 'new-zone-for-original-url', workspaceId: SCRATCH_WORKSPACE_ID })
  expect(planned.spaceZoneBindings[planned.zone.zoneId]?.workspaceId).toBe(SCRATCH_WORKSPACE_ID)
  expect(readRegions).not.toHaveBeenCalled()
})

it.each(['http', 'https'])('system-open: %s reaches an exact durable page without waiting for an unrelated directory or pending bookmark', async scheme => {
  const original = useAppStore.getState(), bookmarkGate = gate(), nativeGate = gate()
  let bookmarkHeld = false, nativeStarted = false, released = false
  vi.mocked(api.scratch.listTopics).mockImplementation(() => new Promise(() => {}))
  const originalCheckpoint = desktopUserFragments.checkpoint
  vi.spyOn(desktopUserFragments, 'checkpoint').mockImplementation(async name => {
    if (name === 'agentBookmarks' && !released) { bookmarkHeld = true; await bookmarkGate.promise }
    return originalCheckpoint(name)
  })
  const key = agentBookmarks.pin({ hostId: 'local', agentSessionId: 'unrelated-bookmark', presentationId: 'original-reader',
    label: 'Unrelated reading', workspaceName: 'Original workspace', excerpt: 'Keep this reading excerpt', bounds: { x: 10, y: 10, width: 300, height: 200 } })!
  const savingBookmark = agentBookmarks.flush()
  await vi.waitFor(() => expect(bookmarkHeld).toBe(true))
  const calls = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => {
    const graph = (await api.spatial.read())!.graph
    const prepared = graph.regions.find(region => region.regionId === id)!
    expect(prepared.kind).toBe('launcher'); expect(graph.tabs.find(tab => tab.tabId === prepared.tabId)!.zoneId).not.toBeNull()
    nativeStarted = true; await nativeGate.promise
    return snapshot(id, url)
  })
  vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  const flow = system(), origin = performance.now()
  try {
    flow.ingress.receive(scheme + '://system-latency.invalid/original')
    await vi.waitFor(() => expect(nativeStarted).toBe(true))
    expect(useAppStore.getState().mainSurface).toBe('survey')
    expect(useAppStore.getState().tabs[tabId]).toBe(original.tabs[tabId])
    const frameworkAtMs = performance.now() - origin
    expect(bookmarkHeld && !released).toBe(true)
    nativeGate.release(); await vi.waitFor(() => expect(flow.outcomes).toHaveLength(1))
    expect(flow.outcomes[0].state).toBe('opened'); expect(calls).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().surveyPageReferences).toHaveLength(1)
    expect(useAppStore.getState().surveyCollectedZones).toEqual({})
    expect(useAppStore.getState().pinnedItems).toEqual(original.pinnedItems)
    expect(flow.issues).toEqual([]); fixture.noLifecycle()
    released = true; bookmarkGate.release(); await savingBookmark
    expect(agentBookmarks.get().bookmarks.find(item => item.key === key)?.excerpt).toBe('Keep this reading excerpt')
    const saved = JSON.parse(desktopUserFragments.read('agentBookmarks')!)
    expect(saved.bookmarks.some((item: any) => item.key === key && item.excerpt === 'Keep this reading excerpt')).toBe(true)
    receipt('unrelated-owner', { scheme, frameworkAtMs, resultAtMs: performance.now() - origin,
      directoryUnresolved: true, bookmarkUnresolvedAtNative: true, bookmarkLaterSaved: true, durableLauncherBeforeNative: true })
  } finally { released = true; bookmarkGate.release(); nativeGate.release(); await savingBookmark; flow.ingress.unavailable(); agentBookmarks.remove(key); await agentBookmarks.flush() }
})

it('system-open: the framework appears before Core acknowledgement, while Native creation requires that exact preparation acknowledgement', async () => {
  const commit = api.spatial.commit, durableGate = gate(), nativeGate = gate()
  let blocked = false, nativeStarted = false
  vi.spyOn(api.spatial, 'commit').mockImplementation(async input => {
    if (!blocked && input.graph.tabs.some(tab => tab.workspaceId === SCRATCH_WORKSPACE_ID)) { blocked = true; await durableGate.promise }
    return commit(input)
  })
  vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => { nativeStarted = true; await nativeGate.promise; return snapshot(id, url) })
  const flow = system()
  try {
    flow.ingress.receive('https://system-latency.invalid/ack')
    await vi.waitFor(() => expect(blocked).toBe(true))
    expect(useAppStore.getState().mainSurface).toBe('survey'); expect(nativeStarted).toBe(false)
    expect(useAppStore.getState().surveyPageOpening).toEqual({ url: 'https://system-latency.invalid/ack' })
    expect(useAppStore.getState().surveyZoneSelection).toBeNull()
    durableGate.release(); await vi.waitFor(() => expect(nativeStarted).toBe(true))
    expect(useAppStore.getState().surveyPageOpening).toEqual({ url: 'https://system-latency.invalid/ack' })
    expect(useAppStore.getState().surveyZoneSelection).toBeNull()
    nativeGate.release(); await vi.waitFor(() => expect(flow.outcomes).toHaveLength(1))
    expect(flow.outcomes[0].state).toBe('opened')
    expect(useAppStore.getState().surveyPageOpening).toBeNull()
    receipt('durable-fence', { targetBeforeAck: true, launcherUnselected: true, nativeAfterExactAck: true })
  } finally { durableGate.release(); nativeGate.release(); flow.ingress.unavailable() }
})

it('system-open: an attached original Browser becomes visible before its reference save acknowledgement, without stealing a later user choice', async () => {
  const saved = gate(), register = useAppStore.getState().registerSurveyBrowserPage
  let browserId: string | undefined
  useAppStore.setState({
    async registerSurveyBrowserPage(reference, profileId, onApplied) {
      const receipt = await register(reference, profileId, onApplied)
      browserId = reference.browserId
      await saved.promise
      return receipt
    }
  })
  vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => snapshot(id, url))
  const flow = system()
  try {
    flow.ingress.receive('https://system-latency.invalid/prefs')
    await vi.waitFor(() => expect(browserId).toBeTypeOf('string'))
    expect(flow.outcomes).toEqual([])
    expect(useAppStore.getState().surveyZoneSelection).toMatchObject({ kind: 'page', browserId })
    expect(useAppStore.getState().surveyPageOpening).toBeNull()
    expect(useAppStore.getState().mainSurface).toBe('survey')
    flow.navigate(); saved.release(); await vi.waitFor(() => expect(flow.outcomes).toHaveLength(1))
    expect(useAppStore.getState().mainSurface).toBe('board')
    receipt('later-choice', { exactBrowserVisibleBeforePreferenceAck: true, laterUserChoiceKept: true })
  } finally { saved.release(); flow.ingress.unavailable() }
})

it('system-open: a slow first Native creation does not block the next link, and late first completion keeps both exact references and the newer page', async () => {
  const first = gate(); let started = 0
  const creates = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => {
    started++
    if (url.endsWith('/first')) await first.promise
    return snapshot(id, url)
  })
  const flow = system(), initialPins = useAppStore.getState().pinnedItems
  try {
    flow.ingress.receive('http://system-latency.invalid/first')
    await vi.waitFor(() => expect(started).toBe(1))
    flow.ingress.receive('https://system-latency.invalid/second')
    await vi.waitFor(() => expect(flow.outcomes).toHaveLength(1))
    expect(started).toBe(2); expect(flow.outcomes[0].state).toBe('opened')
    const second = useAppStore.getState().surveyZoneSelection
    expect(second).toMatchObject({ kind: 'page', browserId: creates.mock.results.length ? creates.mock.calls[1]![0] : '' })
    first.release(); await vi.waitFor(() => expect(flow.outcomes).toHaveLength(2))
    expect(flow.outcomes.every(result => result.state === 'opened')).toBe(true)
    expect(new Set(flow.outcomes.map(result => result.requestId)).size).toBe(2)
    expect(useAppStore.getState().surveyPageReferences).toHaveLength(2)
    expect(useAppStore.getState().surveyZoneSelection).toEqual(second)
    expect(useAppStore.getState().pinnedItems).toBe(initialPins)
    expect(flow.issues).toEqual([]); fixture.noLifecycle()
    receipt('independent-requests', { firstNativeHeldWhileSecondOpened: true, references: 2, originalRequestIds: flow.outcomes.map(result => result.requestId), newerChoiceKept: true })
  } finally { first.release(); flow.ingress.unavailable() }
})

it('system-open: links received in the same turn present the latest explicit input rather than treating another opening as user navigation', async () => {
  const creates = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => snapshot(id, url))
  const flow = system()
  try {
    flow.ingress.receive('http://system-latency.invalid/same-turn-first')
    flow.ingress.receive('https://system-latency.invalid/same-turn-last')
    await vi.waitFor(() => expect(flow.outcomes).toHaveLength(2))
    const latest = creates.mock.calls.find(call => call[1].endsWith('/same-turn-last'))!
    expect(useAppStore.getState().surveyZoneSelection).toMatchObject({ kind: 'page', browserId: latest[0] })
    expect(useAppStore.getState().surveyPageReferences).toHaveLength(2)
    expect(flow.outcomes.every(result => result.state === 'opened')).toBe(true)
    receipt('same-turn-priority', { references: 2, latestExplicitInputSelected: true })
  } finally { flow.ingress.unavailable() }
})

it('system-open: a fresh reference removed during save stays removed on the original preparation Retry', async () => {
  const saving = gate(); let held = false, released = false, preparation: any
  const creates = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => snapshot(id, url))
  fixture.flush.mockImplementation(async () => {
    if (!released && useAppStore.getState().surveyPageReferences.length) { held = true; await saving.promise }
  })
  const original = useAppStore.getState().createSurveyBrowser({ workspaceId: SCRATCH_WORKSPACE_ID, url: 'https://system-latency.invalid/remove',
    preparation: null, onPrepared(value) { preparation = value } })
  try {
    await vi.waitFor(() => expect(held).toBe(true))
    const page = useAppStore.getState().surveyPageReferences[0]!
    await useAppStore.getState().setSurveyPageCollected(page, false)
    released = true; saving.release(); const completed = await original
    expect(completed.admission?.outcome).toBe('unknown')
    expect(completed.admission?.issues[0]?.code).toBe('SURVEY_PAGE_MEMBERSHIP_SUPERSEDED')
    const retry = await useAppStore.getState().createSurveyBrowser({ workspaceId: SCRATCH_WORKSPACE_ID, url: 'https://replacement.invalid/', preparation,
      onPrepared() {} })
    expect(retry.admission?.outcome).toBe('unknown')
    expect(useAppStore.getState().surveyPageReferences).toEqual([])
    expect(creates).toHaveBeenCalledTimes(1)
    receipt('withdrawn-retry', { originalBrowserCreates: 1, removedReferenceNotResurrected: true, originalOutcome: completed.admission?.outcome })
  } finally { saving.release(); await original }
})

it('system-open: unavailable aborts every dispatched exact request and retains only the undispatched input without replay', async () => {
  const ingress = new WebUrlIngress(), first = gate(), requests: any[] = [], signals: AbortSignal[] = [], issues: string[] = []
  const outcome = (request: any) => ({ operation: request.operation, requestId: request.requestId, state: 'opened' as const,
    browserId: request.requestId, reference: { displayWorkspaceId: 'scratch', groupId: 'G', tabId: 'T', regionId: request.requestId } })
  ingress.ready(async (request, signal) => { requests.push(request); signals.push(signal); await first.promise; return outcome(request) }, issue => issues.push(issue))
  for (const id of ['one', 'two', 'three']) ingress.receive('https://system-latency.invalid/' + id)
  try {
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    ingress.unavailable(); expect(signals.every(signal => signal.aborted)).toBe(true)
    const next: any[] = []
    ingress.ready(async request => { next.push(request); return outcome(request) }, issue => issues.push(issue))
    await vi.waitFor(() => expect(next).toHaveLength(1))
    expect(next[0].url).toMatch(/\/three$/)
    first.release(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(requests).toHaveLength(2); expect(next).toHaveLength(1)
    expect(issues).toHaveLength(2)
    for (const request of requests) expect(issues.some(issue => issue.includes(request.requestId))).toBe(true)
    receipt('unavailable', { abortedDispatched: 2, retainedUndispatched: 1, replays: 0 })
  } finally { first.release(); ingress.unavailable() }
})
