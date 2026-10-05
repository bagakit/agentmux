import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '@agentmux/core'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => createElement('div', { 'data-navigation-agent-paint': '' }) }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { installNativePopover } from './fixtures/mote-workface'
import { mainFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { subscribePmoTeamsTopicFloatingState, readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { seedMoteWorkface, defaultTab, neighborTab } from './fixtures/mote-workface'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
const initial = useAppStore.getState()
let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement, dispose: () => void
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.localStorage.clear(); dispose = installNativePopover()
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const workspace = { ...config.workspaces.find(item => item.id === 'workspace-demo')!, path: _hygiene_fixturePath("private/navigation-project") }
  const agent = { ...snapshot.sessions.find(item => item.id === 'session-codex')!, workspacePath: workspace.path }
  const mixed = addWorkbenchRegion(createWorkbenchTab('mixed', { kind: 'file', regionId: 'file', workspaceId: workspace.id, path: 'navigation.txt' }), 'file', 'right',
    { kind: 'agent', phase: 'attached', regionId: 'agent', workspaceId: workspace.id, sessionId: agent.id })
  const launcher = createWorkbenchTab('launcher', { kind: 'launcher', regionId: 'start', workspaceId: workspace.id })
  const page = await api.browser.create('navigation-browser', 'about:blank', workspace.id)
  const browser = createWorkbenchTab('browser', { ...page, kind: 'browser', regionId: 'page', workspaceId: workspace.id, browserId: page.id })
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false,
    config: { ...config, workspaces: [workspace] }, sessions: [agent], tabs: { mixed, launcher, browser },
    layouts: { [workspace.id]: createWorkspaceLayout('exact-group', [mixed.id, launcher.id, browser.id]) }, activeWorkspaceId: workspace.id,
    mainSurface: 'workbench', projectRailOpen: false, toolsOpen: false, demands: {}, selectedDemandId: 'original-goal',
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
  host = document.createElement('div'); document.body.append(host)
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host.remove(); dispose(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear() })
function choose(tabId = 'mixed', regionId = 'file') {
  const state = useAppStore.getState(); state.focusRegion(state.activeWorkspaceId!, tabId, regionId, 'pointer', 'exact-group')
  expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(regionId)
}
async function mount() { root = createRoot(host); await act(async () => root!.render(createElement(App))) }
it.each([['mixed', 'file'], ['launcher', 'start'], ['browser', 'page']])('continues non-Agent %s/%s in the actual Focus workface with the same Work reference', async (tabId, regionId) => {
  choose(tabId, regionId); const held = useAppStore.getState().workbenchSpaceSelection
  useAppStore.getState().setMainSurface('agents'); await mount()
  expect(host.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(tabId)
  expect(host.querySelector(`.focused-tab-workspace [data-workbench-region-id="${regionId}"]`)).not.toBeNull()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(held)
})
it('selects a non-Agent Region in Focus into Work without changing the semantic Agent history or shared layout', async () => {
  choose('mixed', 'agent'); useAppStore.getState().setMainSurface('agents'); await mount()
  const before = useAppStore.getState(), reference = { displayWorkspaceId: before.activeWorkspaceId!, groupId: 'exact-group', tabId: 'mixed', regionId: 'file' }
  await act(async () => host.querySelector<HTMLElement>('.focused-tab-workspace [data-workbench-region-id="file"]')!
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(expect.objectContaining({ tabId: 'mixed', regionId: 'file' }))
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  await act(async () => useAppStore.getState().setMainSurface('workbench'))
  expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(reference.regionId)
})
it('retains unknown Work references and refuses a stale Focus callback after a later selection', () => {
  choose(); const before = useAppStore.getState().workbenchSpaceSelection!
  useAppStore.getState().setMainSurface('agents')
  useAppStore.getState().selectMainRegion({ displayWorkspaceId: before.workspaceId, groupId: 'exact-group', tabId: 'launcher', regionId: 'start' }, before)
  const later = useAppStore.getState().workbenchSpaceSelection
  useAppStore.getState().selectMainRegion({ displayWorkspaceId: before.workspaceId, groupId: 'exact-group', tabId: 'mixed', regionId: 'agent' }, before)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(later)
  const unknown = { ...later!, groupId: 'missing-original-group' }; useAppStore.setState({ workbenchSpaceSelection: unknown })
  const projection = mainFocusPresentation(unknown, useAppStore.getState().tabs, workbenchSelectionCatalog(useAppStore.getState()), () => {})
  expect(projection.projection).toBeNull(); expect(projection.issue).toContain('reference are kept')
  useAppStore.getState().setMainSurface('workbench'); expect(useAppStore.getState().workbenchSpaceSelection).toBe(unknown)
})
it('records a Survey execution Agent focus without changing Work or Survey navigation', () => {
  choose(); const work = useAppStore.getState().workbenchSpaceSelection
  const survey = { zoneId: 'survey-zone', selection: [], active: null }; useAppStore.setState({ mainSurface: 'survey', surveyZoneSelection: survey })
  const state = useAppStore.getState(), id = state.sessions[0]!.id
  state.focusExecutionSession(id, { displayWorkspaceId: state.activeWorkspaceId!, groupId: 'exact-group', tabId: 'mixed', regionId: 'agent' }, { navigate: false })
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(id)
  expect(useAppStore.getState().agentFocus.execution.history).toHaveLength(1)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(work); expect(useAppStore.getState().surveyZoneSelection).toBe(survey)
})
it('a floating Agent selection never changes the shared active Region or Work reference', () => {
  choose(); const before = useAppStore.getState()
  before.focusRegion(before.activeWorkspaceId!, 'mixed', 'agent', 'floating-pointer', 'exact-group')
  const after = useAppStore.getState()
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
  expect(after.workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(after.agentFocus.execution.sessionId).toBe(after.sessions[0]!.id)
})
it('selects a Goal only through a unique confirmed Work association and retains the previous Goal for missing or ambiguous links', async () => {
  choose('mixed', 'agent'); const id = useAppStore.getState().sessions[0]!.id
  const sample = (await api.demands.list())[0]!
  const goal = { ...sample, source: 'default-topic' as const, id: 'linked', sessionIds: [id] }, second = { ...goal, id: 'other' }
  useAppStore.setState({ demands: { linked: goal } }); useAppStore.getState().setMainSurface('board')
  expect(useAppStore.getState().selectedDemandId).toBe('linked')
  useAppStore.setState({ selectedDemandId: 'original-goal', demands: { linked: goal, other: second } })
  useAppStore.getState().setMainSurface('board'); expect(useAppStore.getState().selectedDemandId).toBe('original-goal')
  useAppStore.setState({ demands: {} }); useAppStore.getState().setMainSurface('board')
  expect(useAppStore.getState().selectedDemandId).toBe('original-goal')
  useAppStore.setState({ demands: { linked: goal } }); choose('mixed', 'file'); useAppStore.getState().setMainSurface('board')
  expect(useAppStore.getState().selectedDemandId).toBe('original-goal')
  useAppStore.getState().setSelectedDemand('linked'); expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe('agent')
})

it('keeps Survey selection and semantic Agent history local through the actual Survey pointer owner', async () => {
  choose(); const before = useAppStore.getState(), work = before.workbenchSpaceSelection
  const zoneId = workbenchSelectionCatalog(before).locations.find(location => location.tabId === 'mixed')!.zoneId!
  const selected = { zoneId, selection: [{ tabId: 'mixed', regionId: 'file' }], active: { tabId: 'mixed', regionId: 'file' } }
  before.setSurveyZoneSelection(selected)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(work)
  useAppStore.setState({ surveyCollectedZones: { [zoneId]: true } }); useAppStore.getState().setMainSurface('survey'); await mount()
  const target = host.querySelector<HTMLElement>('.global-survey-surface [data-workbench-region-id="agent"]')
  expect(target).not.toBeNull()
  await act(async () => target!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  const after = useAppStore.getState()
  expect(after.surveyZoneSelection?.active).toEqual({ tabId: 'mixed', regionId: 'agent' })
  expect(after.agentFocus.execution.sessionId).toBe(after.sessions[0]!.id)
  expect(after.agentFocus.execution.history).toHaveLength(1)
  expect(after.workbenchSpaceSelection).toBe(work); expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
  await act(async () => after.setMainSurface('workbench'))
  expect(useAppStore.getState().surveyZoneSelection?.active?.regionId).toBe('agent')
  expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe('file')
})

it('keeps a real Survey Tab click local while retaining the original Work occurrence', async () => {
  choose('mixed', 'file')
  const before = useAppStore.getState(), work = before.workbenchSpaceSelection!
  before.setSurveyZoneSelection({ zoneId: work.zoneId!, selection: [{ tabId: 'mixed', regionId: 'file' }], active: { tabId: 'mixed', regionId: 'file' } })
  useAppStore.setState({ surveyCollectedZones: { [work.zoneId!]: true } })
  before.setMainSurface('survey'); await mount()
  const tab = host.querySelector<HTMLButtonElement>('.global-survey-surface button[data-workbench-tab-id="browser"]')
  expect(tab).not.toBeNull()
  await act(async () => tab!.click())
  const after = useAppStore.getState()
  expect(after.surveyZoneSelection?.active).toEqual({ tabId: 'browser', regionId: 'page' })
  expect(after.workbenchSpaceSelection).toBe(work)
  expect(after.mainSurface).toBe('survey')
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
  expect(after.agentFocus).toBe(before.agentFocus); expect(after.sessions).toBe(before.sessions)
})

it('keeps explicit public focus reachable from Survey without overwriting its local selection', async () => {
  choose('mixed', 'file')
  const before = useAppStore.getState(), work = before.workbenchSpaceSelection!
  before.setSurveyZoneSelection({ zoneId: work.zoneId!, selection: [{ tabId: 'mixed', regionId: 'agent' }], active: { tabId: 'mixed', regionId: 'agent' } })
  const survey = useAppStore.getState().surveyZoneSelection
  before.setMainSurface('survey'); await mount()
  let pending!: ReturnType<typeof before.executeControl>
  await act(async () => {
    pending = useAppStore.getState().executeControl(parseAgentMuxControlRequest({
      schemaVersion: 5, requestId: 'survey-explicit-focus', operation: 'focus', inputPolicy: 'preserve',
      target: { kind: 'space', tabId: 'launcher', regionId: 'start',
        displayWorkspaceId: work.workspaceId, groupId: work.groupId! }
    }))
    await Promise.resolve()
  })
  const result = await pending
  expect(result.operation).toBe('focus')
  if (result.operation !== 'focus') throw new Error('Expected the original public focus result')
  const { operation, ...body } = result
  expect(parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'survey-explicit-focus', operation, ok: true, result: body })).toMatchObject({ result: body })
  expect(result.navigation.state).toBe('applied')
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(expect.objectContaining({
    workspaceId: work.workspaceId, groupId: work.groupId, tabId: 'launcher', regionId: 'start' }))
  expect(useAppStore.getState().surveyZoneSelection).toBe(survey)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})

it.each(['survey', 'mote'] as const)('opens a directional HTTP link through the original %s owner without moving Work', async surface => {
  if (surface === 'mote') {
    seedMoteWorkface()
    useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, neighborTab.id, neighborTab.layout.activeRegionId, 'pointer', 'mote-group')
  } else choose('mixed', 'file')
  const before = useAppStore.getState(), work = before.workbenchSpaceSelection
  const origin = surface === 'mote'
    ? { workspaceId: SCRATCH_WORKSPACE_ID, tabGroupId: 'mote-group', tabId: defaultTab.id, regionId: 'default-region' }
    : { workspaceId: before.activeWorkspaceId!, tabGroupId: 'exact-group', tabId: 'mixed', regionId: 'agent' }
  const reference = { displayWorkspaceId: origin.workspaceId, groupId: origin.tabGroupId, tabId: origin.tabId, regionId: origin.regionId }
  const tab = before.tabs[origin.tabId]!
  expect(work?.zoneId).toBeTruthy()
  const survey = { zoneId: work!.zoneId!, selection: [{ tabId: origin.tabId, regionId: origin.regionId }], active: { tabId: origin.tabId, regionId: origin.regionId } }
  useAppStore.setState({ mainSurface: surface === 'survey' ? 'survey' : 'agents', surveyZoneSelection: survey })
  const releaseMote = surface === 'mote' ? subscribePmoTeamsTopicFloatingState(() => {}) : () => {}
  if (surface === 'mote') requestPmoTeamsTopicFloatingOpen({ targetTabId: origin.tabId, reference })
  const select = vi.fn((regionId: string) => {
    if (surface === 'survey') useAppStore.getState().setSurveyZoneSelection({ ...survey, selection: [{ tabId: origin.tabId, regionId }], active: { tabId: origin.tabId, regionId } })
    else requestPmoTeamsTopicFloatingOpen({ targetTabId: origin.tabId, reference: { ...reference, regionId } })
  })
  await useAppStore.getState().openHttpLink(origin, 'https://example.test/local', 'right', { surface, onSelectRegion: select })
  expect(select).toHaveBeenCalledTimes(1)
  const regionId = select.mock.calls[0]![0]
  expect(useAppStore.getState().tabs[origin.tabId]?.regions[regionId]?.kind).toBe('browser')
  expect(surface === 'survey' ? useAppStore.getState().surveyZoneSelection?.active : readPmoTeamsTopicFloatingState()?.reference).toEqual(expect.objectContaining({ tabId: origin.tabId, regionId }))
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(work)
  expect(useAppStore.getState().tabs[origin.tabId]?.layout.activeRegionId).toBe(tab.layout.activeRegionId)
  expect(useAppStore.getState().mainSurface).toBe(surface === 'survey' ? 'survey' : 'agents')
  if (surface === 'mote') requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
  releaseMote()
})
it('keeps a later Survey selection even when it returns to the old Region before a Browser result', async () => {
  choose('mixed', 'file'); const state = useAppStore.getState(), work = state.workbenchSpaceSelection
  expect(work?.zoneId).toBeTruthy()
  const survey = { zoneId: work!.zoneId!, selection: [{ tabId: 'mixed', regionId: 'agent' }], active: { tabId: 'mixed', regionId: 'agent' } }
  useAppStore.setState({ mainSurface: 'survey', surveyZoneSelection: survey })
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve }), original = api.browser.create
  vi.spyOn(api.browser, 'create').mockImplementationOnce(async (...args) => { await wait; return original(...args) })
  const select = vi.fn()
  const pending = useAppStore.getState().openHttpLink({ workspaceId: state.activeWorkspaceId!, tabGroupId: 'exact-group', tabId: 'mixed', regionId: 'agent' },
    'https://example.test/late', 'right', { surface: 'survey', onSelectRegion: select })
  state.setSurveyZoneSelection({ ...survey, active: { tabId: 'mixed', regionId: 'file' } }); state.setSurveyZoneSelection(survey)
  release(); await pending
  expect(select).not.toHaveBeenCalled(); expect(useAppStore.getState().surveyZoneSelection).toEqual(survey)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(work)
  expect(Object.values(useAppStore.getState().tabs.mixed!.regions).filter(region => region.kind === 'browser')).toHaveLength(1)
})

it.each(['browser', 'agent'] as const)('keeps the original Agent identity when its historical Region is reused by a healthy %s', kind => {
  choose('mixed', 'agent'); choose('mixed', 'file')
  const state = useAppStore.getState(), original = state.sessions[0]!, reference = state.agentFocus.execution.reference
  const other = { ...original, id: 'healthy-other-agent' }
  const replacement = kind === 'browser' ? { ...state.tabs.browser!.regions.page!, regionId: 'agent' }
    : { ...state.tabs.mixed!.regions.agent!, sessionId: other.id }
  const peer = createWorkbenchTab('original-session-elsewhere', { kind: 'agent', phase: 'attached',
    regionId: 'original-peer-region', workspaceId: original.workspacePath === state.config!.workspaces[0]!.path ? state.config!.workspaces[0]!.id : state.activeWorkspaceId!, sessionId: original.id })
  useAppStore.setState({ sessions: [...state.sessions, other],
    tabs: { ...state.tabs, mixed: { ...state.tabs.mixed!, regions: { ...state.tabs.mixed!.regions, agent: replacement } }, [peer.id]: peer },
    layouts: { [state.activeWorkspaceId!]: createWorkspaceLayout('exact-group', ['mixed', 'launcher', 'browser', peer.id]) } })
  const before = useAppStore.getState(), report = vi.spyOn(before, 'reportError')
  expect(before.focusExecutionSession(original.id)).toBe(false)
  const after = useAppStore.getState()
  expect(after.agentFocus.execution.sessionId).toBe(original.id)
  expect(after.agentFocus.execution.reference).toEqual(reference)
  expect(after.workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
  expect(after.sessions).toBe(before.sessions); expect(after.tabs.mixed?.regions.agent).toBe(replacement)
  expect(report).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ kind: 'indeterminate' }))
})
