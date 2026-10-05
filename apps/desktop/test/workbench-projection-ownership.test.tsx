import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { pmoTeamsTopicFloatingTargetTabId, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry'
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workbenchProjectionSlotId, type WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { moteWorkbenchProjection } from '../src/renderer/src/lib/mote-workbench-projection'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { installNativePopover } from './fixtures/mote-workface'

const baseline = useAppStore.getState()
const first = { ...createWorkbenchTab('first-tab', { kind: 'launcher', regionId: 'first-region', workspaceId: SCRATCH_WORKSPACE_ID }, 'First context'), topicId: PMO_TEAMS_TOPIC_ID }
const second = { ...createWorkbenchTab('second-tab', { kind: 'launcher', regionId: 'second-region', workspaceId: SCRATCH_WORKSPACE_ID }, 'Second context'), topicId: PMO_TEAMS_TOPIC_ID }
let root: Root, container: HTMLDivElement, restorePopover: () => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear(); restorePopover = installNativePopover()
  useAppStore.setState({ tabs: { [first.id]: first, [second.id]: second }, sessions: [], agentNames: {}, timelines: {},
    config: null, scratchTopicSnapshots: {}, workspaceFileRevisions: {}, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [first.id, second.id]) },
    mainSurface: 'board', projectRailOpen: false, toolsOpen: false })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); restorePopover(); window.localStorage.clear()
  vi.restoreAllMocks(); useAppStore.setState(baseline, true)
})

const firstReference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'group', tabId: first.id, regionId: 'first-region' }
const secondReference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'group', tabId: second.id, regionId: 'second-region' }
function publicProjection(onSelect = vi.fn()): WorkbenchProjection {
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {},
    workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("topics"), name: 'Topics', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } } })
  const topic = { id: PMO_TEAMS_TOPIC_ID, directoryPath: _hygiene_fixturePath("topics/topic--launcher--leader"), topicPath: _hygiene_fixturePath("topics/topic--launcher--leader/topic.md"),
    title: 'Mote', summary: '', collaborators: [] }
  const catalog = spatialCatalog(useAppStore.getState(), [topic])
  const zoneId = catalog.tabs.find(tab => tab.tabId === first.id)!.zoneId
  expect(zoneId).not.toBeNull()
  return { entity: { kind: 'zone', zoneId: zoneId! }, presentationId: 'projection', displayWorkspaceId: SCRATCH_WORKSPACE_ID,
    catalog, selection: [firstReference], onSelect }
}

it.each(['board', 'agents'] as const)('lets only the window workbench own global chrome above %s', async (mainSurface) => {
  useAppStore.setState({ mainSurface })
  const projectionState = publicProjection()
  await act(async () => root.render(createElement(Fragment, null,
    createElement('div', { 'data-owner': true }, createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID, visible: false })),
    createElement('div', { 'data-projection': true }, createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID,
      topicId: PMO_TEAMS_TOPIC_ID, viewOwnership: 'projection', projection: projectionState }))
  )))
  const owner = container.querySelector('[data-owner]')!, projection = container.querySelector('[data-projection]')!
  expect(owner.querySelector('.top-row-leading-chrome')).not.toBeNull()
  expect(owner.querySelector('.breadcrumbs')?.textContent).toContain(mainSurface === 'board' ? 'Goals' : 'Focus')
  expect(projection.querySelector('.top-row-leading-chrome')).toBeNull()
  expect(projection.querySelector('.breadcrumbs')).toBeNull()
  expect(projection.querySelectorAll('.workbench-tab')).toHaveLength(2)
  expect(projection.querySelector('.pane-tabbar__actions')).not.toBeNull()
  expect(projection.querySelector('[title="New tab"]')).not.toBeNull()
})

it('retains only the missing projection target slot while other Tabs are available', async () => {
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID,
    topicId: PMO_TEAMS_TOPIC_ID, viewOwnership: 'projection', retainedTabId: 'restoring-tab', viewHostPrefix: 'projection-slot' })))
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Original Tab retained')
  expect(container.querySelector('[data-workbench-retained-reference="restoring-tab"]')).not.toBeNull()
  // An absent entity retains its exact reference, without minting a content slot.
  expect(container.querySelector('[data-workbench-tab-id="restoring-tab"]')).toBeNull()
  // Explicit recovery navigation keeps both original choices without selecting
  // either one or guessing a replacement for the absent content owner.
  expect(container.querySelectorAll('.workbench-tab')).toHaveLength(2)
  expect(container.querySelector('.workbench-tab--active')).toBeNull()
  expect(container.querySelector('.workbench-tab-slot')).toBeNull()
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBe(first.id)
  expect(useAppStore.getState().tabs).toEqual({ [first.id]: first, [second.id]: second })
})

it('reports actual Tab clicks and native focus in retained content through the visible projection', async () => {
  const selected = vi.fn(), projection = publicProjection(selected)
  const originalLayout = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID,
    topicId: PMO_TEAMS_TOPIC_ID, viewOwnership: 'projection', projection })))
  const button = container.querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${second.id}"]`)!
  expect(button).not.toBeNull()
  await act(async () => button.click())
  expect(selected).toHaveBeenCalledExactlyOnceWith(secondReference)
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toBe(originalLayout)
  selected.mockClear()
  // The retained portal's DOM enters this host even though its React owner is
  // elsewhere. Native focus must therefore identify the visible slot's exact Tab.
  const slotId = workbenchProjectionSlotId('projection-slot', { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'group', tabId: first.id })
  const slot = Array.from(container.querySelectorAll<HTMLElement>('[id]')).find(element => element.id === slotId)!
  expect(slot).not.toBeNull()
  const input = document.createElement('input'); slot.append(input)
  await act(async () => input.focus())
  expect(selected).toHaveBeenCalledExactlyOnceWith(firstReference)
  expect(document.activeElement).toBe(input)
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toBe(originalLayout)
  selected.mockClear()
  // A queued retained focus cannot overtake a later explicitly focused control.
  const later = document.createElement('input'); container.append(later)
  await act(async () => { later.focus(); input.focus(); later.focus() })
  expect(selected).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(later)
  // An unconfirmed physical occurrence refuses only that selection. The input
  // and all original entities remain available; no current Group is borrowed.
  slot.dataset.workbenchGroupId = 'unconfirmed-group'
  await act(async () => input.focus())
  expect(selected).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(input)
  expect(input.isConnected).toBe(true)
  expect(useAppStore.getState().tabs).toEqual({ [first.id]: first, [second.id]: second })
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toBe(originalLayout)
})

it.each([
  { missing: false, choice: 'select', outcome: 'success' },
  { missing: false, choice: 'select', outcome: 'failure' },
  { missing: true, choice: 'select', outcome: 'success' },
  { missing: true, choice: 'select', outcome: 'failure' },
  { missing: true, choice: 'keep', outcome: 'success' },
  { missing: true, choice: 'keep', outcome: 'failure' },
  { missing: false, choice: 'close-reopen', outcome: 'success' },
  { missing: false, choice: 'close-reopen', outcome: 'failure' },
  { missing: true, choice: 'navigate', outcome: 'success' }
] as const)('owns full Space continuation with missing=$missing, choice=$choice, outcome=$outcome', async ({ missing, choice, outcome }) => {
  const report = vi.fn()
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {},
    workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("topics"), name: 'Topics', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    agentComposerDrafts: { original: 'Original input' }, prewarmTerminal: vi.fn(), reportError: report,
    ...(missing ? { tabs: { [second.id]: second }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [second.id]) } } : {}) })
  const topic = { id: PMO_TEAMS_TOPIC_ID, directoryPath: _hygiene_fixturePath("topics/topic--launcher--leader"), topicPath: _hygiene_fixturePath("topics/topic--launcher--leader/topic.md"),
    title: 'Mote', summary: '', collaborators: [] }
  const workspace = useAppStore.getState().config!.workspaces[0]!
  useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(workspace),
    topics: [topic], revision: 0, reading: false, error: null } } })
  vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(topic)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  const launch = vi.spyOn(api.sessions, 'launchTerminal')
  const focus = vi.fn<typeof baseline.executeControl>(baseline.executeControl)
  useAppStore.setState({ executeControl: focus })
  const key = 'agentmux.leader-topic-floating.v1'
  window.localStorage.setItem(key, JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: first.id, reference: firstReference }))
  function Floating() {
    const [floating, setFloating] = usePmoTeamsTopicFloatingState()
    const state = useAppStore()
    const tabId = pmoTeamsTopicFloatingTargetTabId(floating, state.tabs, state.layouts[SCRATCH_WORKSPACE_ID], state.agentFocus.pmo.sessionId)
    const projectionState = moteWorkbenchProjection(spatialCatalog(state, [topic]), tabId ? state.tabs[tabId] : undefined,
      floating, reference => setFloating({ targetTabId: reference.tabId, reference }), state.layouts)
    return createElement(PmoTeamsTopicFloatingPanel, { floating, setFloating, projectionState })
  }
  await act(async () => root.render(createElement(Fragment, null, createElement(PmoTeamsTopicEntry), createElement(Floating))))
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Mote"]')!.click())
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  report.mockClear()
  if (missing) {
    // An absent entity is not a cold metadata request. The exact raw reference
    // stays unknown until its original owner restores it and the user retries.
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open in Space"]')!.click())
    expect(focus).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining('not confirmed') }))
    expect(JSON.parse(window.localStorage.getItem(key)!).reference).toEqual(firstReference)
    expect(useAppStore.getState().tabs).toEqual({ [second.id]: second })
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBe(second.id)
    await act(async () => useAppStore.setState({ tabs: { [first.id]: first, [second.id]: second },
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [second.id, first.id]) } }))
    report.mockClear()
  }
  const originalLayout = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]
  let finish!: () => void, fail!: (error: Error) => void
  const completion = new Promise<Error | undefined>(resolve => { finish = () => resolve(undefined); fail = resolve })
  focus.mockImplementation(async (request, signal, options) => {
    const receipt = await baseline.executeControl(request, signal, options)
    // Hold only this original public focus receipt after the real owner has
    // committed its Work choice; later local navigation must still win.
    const failure = await completion
    if (failure) throw failure
    return receipt
  })
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open in Space"]')!.click())
  expect(focus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'focus', inputPolicy: 'preserve',
    target: expect.objectContaining({ kind: 'space', ...firstReference }) }), expect.any(AbortSignal))
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID,
    groupId: firstReference.groupId, tabId: firstReference.tabId, regionId: firstReference.regionId })
  // This explicit public navigation focuses the original occurrence; subsequent
  // selection inside the floating presentation must not navigate it again.
  const focusedLayout = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]
  expect(focusedLayout).toEqual({ ...originalLayout, groups: [{ ...originalLayout!.groups[0]!,
    activeTabId: first.id, recentTabIds: missing ? [second.id, first.id] : [first.id] }] })
  if (choice === 'select') {
    const other = container.querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${second.id}"]`)!
    expect(other).not.toBeNull()
    await act(async () => other.click())
    // Floating selection owns the exact visible target, while the original
    // durable workface behind it keeps its navigation selection.
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toBe(focusedLayout)
    expect(JSON.parse(window.localStorage.getItem(key)!).targetTabId).toBe(second.id)
  } else if (choice === 'close-reopen') {
    await act(async () => container.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')!.click())
  } else if (choice === 'navigate') {
    await act(async () => useAppStore.getState().setMainSurface('board'))
  }
  const error = new Error('Public focus receipt failed')
  await act(async () => {
    if (outcome === 'success') finish(); else fail(error)
    await focus.mock.results[0]!.value.catch(() => {})
  })
  const completed = choice === 'keep' && outcome === 'success'
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toBe(focusedLayout)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID,
    groupId: firstReference.groupId, tabId: firstReference.tabId, regionId: firstReference.regionId })
  const floating = JSON.parse(window.localStorage.getItem(key)!)
  expect(floating.open).toBe(!completed)
  expect(floating.targetTabId).toBe(choice === 'select' ? second.id : first.id)
  expect(container.querySelector<HTMLElement>('[role="dialog"]')!.dataset.moteTargetTab).toBe(floating.targetTabId)
  expect(useAppStore.getState().mainSurface).toBe(choice === 'navigate' ? 'board' : 'workbench')
  if (choice === 'keep' && outcome === 'failure') {
    expect(report).toHaveBeenCalledExactlyOnceWith(error)
    expect(container.textContent).toContain('Opening this context in Space did not complete')
  } else {
    expect(report).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Opening this context in Space did not complete')
  }
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ original: 'Original input' })
  expect(useAppStore.getState().tabs).toEqual({ [first.id]: first, [second.id]: second })
  expect(useAppStore.getState().sessions).toEqual([])
  expect(launch).not.toHaveBeenCalled()
})
