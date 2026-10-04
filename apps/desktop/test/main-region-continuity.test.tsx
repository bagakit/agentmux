// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createWorkspaceLayout, moveTabToNewGroup, addTabOccurrence } from '@agentmux/layout'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { mainFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { useWorkbenchObjectLayout } from '../src/renderer/src/hooks/useWorkbenchObjectLayout'
import { desktopSelection, mainRegionReference, workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { GlobalSurveySurface } from '../src/renderer/src/components/GlobalSurveySurface'
import { GoalExecution } from '../src/renderer/src/components/GoalExecution'
import { resolveWorkbenchZone } from '../src/renderer/src/lib/workbench-projection'
import { surveyResolvedZoneSelection } from '../src/renderer/src/lib/survey-workface'
// Unselected continuation actions do not participate in this Goal navigation counter.
vi.mock('../src/renderer/src/components/GoalContinuationControl', () => ({ GoalContinuationControl: () => null }))
import { FocusToolbar } from '../src/renderer/src/components/FocusToolbar'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { seedMoteWorkface, executionAgent, defaultAgent, ordinaryAgent, moteTopics } from './fixtures/mote-workface'

const baseline = useAppStore.getState()
const sourceId = 'displayed-complete-tab', sourceRegion = 'displayed-agent-region'
const reference = { displayWorkspaceId: 'project', groupId: 'exact-second-group', tabId: sourceId, regionId: sourceRegion }
const navigation = { open() {}, openToolkit() {}, openHost() {} }
let root: Root, container: HTMLDivElement
let observed: any
let controls: ReturnType<typeof vi.fn>

// Thin host only: actual SurfaceSwitch, FocusToolbar, Store, Focus projector and
// Space object-layout hook. It does not substitute the production navigation branch.
function Scene() {
  const state = useAppStore()
  const object = useWorkbenchObjectLayout(state.activeWorkspaceId ?? '', state.layouts[state.activeWorkspaceId ?? ''])
  const presentation = mainFocusPresentation(state.workbenchSpaceSelection, state.tabs, spatialCatalog(state, moteTopics),
    next => state.selectMainRegion(next, state.workbenchSpaceSelection))
  const selected = presentation.projection?.selection[0]
  const catalog = spatialCatalog(state, moteTopics)
  const surveyProjection = state.surveyZoneSelection ? resolveWorkbenchZone(state.surveyZoneSelection.zoneId, catalog, state.layouts, state.tabs, 'survey-workbench', state.surveyZoneSelection.active ? [state.surveyZoneSelection.active] : [], () => {}) : null
  const survey = state.surveyZoneSelection ? surveyResolvedZoneSelection(state.surveyZoneSelection, surveyProjection, mainRegionReference(state.workbenchSpaceSelection)) : null
  observed = { mainSurface: state.mainSurface, activeWorkspaceId: state.activeWorkspaceId,
    choice: state.workbenchSpaceSelection, selection: desktopSelection(state, workbenchSelectionCatalog(state)),
    projectedChoice: object.choice, projectedGroups: object.layout?.groups.map(group => ({ id: group.id, activeTabId: group.activeTabId, tabs: group.tabOrder })),
    projectionConfirmed: object.confirmed, focusReference: selected ?? null,
    agentReference: state.agentFocus.execution.reference, execution: state.agentFocus.execution.sessionId, error: state.error, survey, goalId: state.selectedDemandId }
  return createElement(SettingsNavigation.Provider, { value: navigation },
    createElement(SurfaceSwitch),
    createElement(FocusToolbar, { selectedId: state.agentFocus.execution.sessionId, selected: undefined,
      tab: selected ? state.tabs[selected.tabId]! : null, reference: selected,
      onReview() {}, onCloseWorkspace() {}, children: null }),
    state.mainSurface === 'survey' ? createElement(GlobalSurveySurface, { catalog, projection: null, selection: survey }) : null,
    state.mainSurface === 'board' && state.demands['goal-counter'] ? createElement(GoalExecution, { demand: state.demands['goal-counter'] as any, onUpdate() {} }) : null)
}
const click = (label: string) => act(async () => {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)
  expect(button, 'real native production button is required').toBeTruthy()
  button!.click()
})
const record = (name: string, extra = {}) => appendFileSync(process.env.AGENTMUX_RETURN_FACTS!, JSON.stringify({ name, ...observed,
  controls: controls.mock.calls.length, ...extra }) + '\n')
const seedOldTopic = async (sessionId: string) => {
  await act(async () => useAppStore.getState().selectSession(sessionId))
  expect(useAppStore.getState().workbenchSpaceSelection?.workspaceId).toBe(SCRATCH_WORKSPACE_ID)
  await act(async () => {
    useAppStore.getState().setMainSurface('agents')
    useAppStore.getState().focusExecutionSession(executionAgent.id, reference)
  })
  expect(observed.focusReference).toEqual(reference)
}
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); useAppStore.setState(baseline, true); seedMoteWorkface()
  controls = vi.fn(async () => {})
  const state = useAppStore.getState()
  const agent = createWorkbenchTab(sourceId, { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: sourceRegion, sessionId: executionAgent.id }, 'Same visible name')
  const file = addWorkbenchRegion(agent, sourceRegion, 'right', { kind: 'file', workspaceId: 'project', regionId: 'source-file', path: 'review.md' })
  const source = addWorkbenchRegion(file, 'source-file', 'down', { kind: 'browser', workspaceId: 'project', regionId: 'source-browser', browserId: 'existing-browser', id: 'existing-browser', navigationId: 'original-navigation', profileId: 'original-profile', url: 'https://example.test/', title: 'Original page', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null })
  const decoy = createWorkbenchTab('ordinary-decoy', { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'decoy-region', sessionId: executionAgent.id }, 'Same visible name')
  const split = moveTabToNewGroup(createWorkspaceLayout('ordinary-group', [decoy.id, source.id]), source.id, 'ordinary-group', 'ordinary-group', 'right', reference.groupId)
  const layout = addTabOccurrence(split, 'ordinary-group', source.id)!
  useAppStore.setState({ tabs: { ...state.tabs, [source.id]: source, [decoy.id]: decoy },
    layouts: { ...state.layouts, project: { ...layout, activeGroupId: 'ordinary-group' } }, activeWorkspaceId: SCRATCH_WORKSPACE_ID,
    workbenchSpaceSelection: null, retainedSpatialFocus: null, mainSurface: 'agents',
    agentFocus: { ...state.agentFocus, execution: { sessionId: executionAgent.id, history: [], reference } },
    launchAgent: controls,  agentComposerDrafts: { ...state.agentComposerDrafts, [sourceRegion]: 'Source Region unsent' } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(createElement(Scene)))
})
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); localStorage.clear(); vi.restoreAllMocks(); useAppStore.setState(baseline, true) })

it('baseline: bottom Space follows exact Agent occurrence when no previous object choice exists', async () => {
  const before = useAppStore.getState()
  await click('Space: show terminal and file workbench'); record('baseline-Agent-bottom')
  expect(observed.choice).toMatchObject({ workspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: sourceId, regionId: sourceRegion })
  expect(observed.projectionConfirmed).toBe(true); expect(controls).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it.each([[defaultAgent.id, 'Mote'], [ordinaryAgent.id, 'Topic']])('main Region: old %s object does not suppress explicit bottom Space return to Focus Region (%s)', async (sid, kind) => {
  await seedOldTopic(sid)
  const before = useAppStore.getState()
  await click('Space: show terminal and file workbench'); record(`${kind}-bottom-return`, { oldTopic: before.workbenchSpaceSelection })
  expect(controls).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(observed.choice, 'new user contract: exact displayed Focus Region, not retained old object').toMatchObject({ workspaceId: 'project', groupId: reference.groupId, tabId: sourceId, regionId: sourceRegion })
})
it('baseline: explicit Toolbar View in Space overrides the old Mote choice with the exact occurrence', async () => {
  await seedOldTopic(defaultAgent.id)
  await click('View in Space'); record('Mote-Toolbar-return')
  expect(observed.choice).toMatchObject({ workspaceId: 'project', groupId: reference.groupId, tabId: sourceId, regionId: sourceRegion })
  expect(observed.projectionConfirmed).toBe(true); expect(controls).not.toHaveBeenCalled()
})
it.each(['source-file', 'source-browser'])('main Region: bottom Space preserves the exact Focus sibling %s instead of reverting to Agent SID Region', async regionId => {
  await act(async () => useAppStore.getState().selectMainRegion({ ...reference, regionId }, useAppStore.getState().workbenchSpaceSelection))
  expect(observed.focusReference).toEqual({ ...reference, regionId })
  await click('Space: show terminal and file workbench'); record(`${regionId}-bottom-return`)
  expect(controls).not.toHaveBeenCalled()
  expect(observed.choice).toMatchObject({ workspaceId: 'project', groupId: reference.groupId, tabId: sourceId, regionId })
})
it.each(['source-file', 'source-browser'])('baseline: Toolbar preserves exact Focus sibling %s', async regionId => {
  await act(async () => useAppStore.getState().selectMainRegion({ ...reference, regionId }, useAppStore.getState().workbenchSpaceSelection))
  await click('View in Space'); record(`${regionId}-Toolbar-return`)
  expect(observed.choice).toMatchObject({ workspaceId: 'project', groupId: reference.groupId, tabId: sourceId, regionId })
  expect(controls).not.toHaveBeenCalled()
})
it('main Region: native Space→Focus shows global main Mote Region without borrowing the old execution Agent', async () => {
  await act(async () => useAppStore.getState().selectSession(defaultAgent.id))
  const global = useAppStore.getState().workbenchSpaceSelection!
  expect(global.regionId).toBe('default-region')
  const execution = useAppStore.getState().agentFocus.execution
  await click('Focus: show execution contexts'); record('Space-Mote-to-Focus')
  expect(useAppStore.getState().agentFocus.execution).toBe(execution)
  expect(observed.focusReference).toEqual({ displayWorkspaceId: global.workspaceId, groupId: global.groupId, tabId: global.tabId, regionId: global.regionId })
})

it('main Region: actual Survey item selection updates the common main Region instead of retaining old Mote', async () => {
  await seedOldTopic(defaultAgent.id)
  const state = useAppStore.getState(), catalog = spatialCatalog(state, moteTopics)
  const zoneId = catalog.tabs.find(tab => tab.tabId === sourceId)!.zoneId!
  await act(async () => state.setSurveyZoneCollected(zoneId, true))
  await click('Survey: browse and explore')
  const item = [...container.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(row => row.dataset.surveyZoneId === zoneId)?.querySelector<HTMLButtonElement>('button.survey-item')
  expect(item, 'actual Survey row is required').toBeTruthy()
  await act(async () => item!.click())
  expect(observed.survey?.zoneId).toBe(zoneId); expect(observed.survey?.active).toBeTruthy()
  record('Survey-native-item-common-choice')
  expect(controls).not.toHaveBeenCalled()
  expect(observed.choice).toMatchObject({ workspaceId: observed.survey.active.displayWorkspaceId,
    groupId: observed.survey.active.groupId, tabId: observed.survey.active.tabId, regionId: observed.survey.active.regionId })
})
it('main Region: actual Goals Open in Space chooses main Mote, subsequent native Focus follows that Region', async () => {
  await act(async () => useAppStore.setState({ demands: { 'goal-counter': { id: 'goal-counter', title: 'Retained Goal', sessionIds: [defaultAgent.id], status: 'draft' } } as any }))
  await click('Goals: show goals and progress')
  const native = container.querySelector<HTMLButtonElement>('.goals-execution__row button')
  expect(native?.textContent).toContain('Open in Space')
  await act(async () => native!.click())
  const global = useAppStore.getState().workbenchSpaceSelection!
  expect(global.regionId).toBe('default-region')
  const execution = useAppStore.getState().agentFocus.execution
  await click('Focus: show execution contexts'); record('Goals-Mote-Space-Focus')
  expect(useAppStore.getState().agentFocus.execution).toBe(execution); expect(controls).not.toHaveBeenCalled()
  expect(observed.focusReference).toEqual({ displayWorkspaceId: global.workspaceId, groupId: global.groupId, tabId: global.tabId, regionId: global.regionId })
})
it.each([executionAgent, ordinaryAgent])('main Region: floating-pointer keeps execution reference/history and common main Region for $id in a Mote sidecar', async floatingAgent => {
  await seedOldTopic(defaultAgent.id)
  const state = useAppStore.getState()
  expect(state.sessions.some(session => session.id === floatingAgent.id)).toBe(true)
  const tab = addWorkbenchRegion(state.tabs['default-tab']!, 'default-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'floating-execution', sessionId: floatingAgent.id })
  await act(async () => useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: tab } }))
  const before = useAppStore.getState(), execution = before.agentFocus.execution, choice = before.workbenchSpaceSelection
  await act(async () => useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, tab.id, 'floating-execution', 'floating-pointer', 'mote-group'))
  record('floating-pointer-execution-isolation', { beforeExecution: execution, beforeChoice: choice })
  expect(useAppStore.getState().tabs[tab.id]!.layout.activeRegionId).toBe('floating-execution')
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(choice); expect(controls).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().agentFocus.execution).toEqual(execution)
})
