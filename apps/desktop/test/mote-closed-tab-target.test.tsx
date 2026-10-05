import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import type { WorkbenchProjectionSelection } from '../src/renderer/src/lib/workbench-projection'
import { subscribeWorkbenchTabRemoved } from '../src/renderer/src/lib/workbench-tab-removal'
import { directoryIdentity, homeZoneId, spatialSources } from '../src/shared/space-addresses'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, customTab, defaultAgent, defaultTab, moteTopics, neighborTab, savedMoteKey } from './fixtures/mote-workface'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })

async function openSavedTarget(tabId: string | null = defaultTab.id, topicId = PMO_TEAMS_TOPIC_ID, reference?: WorkbenchProjectionSelection) {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: topicId, targetTabId: tabId, reference }))
  await app.mount()
  expect(app.panel().dataset.moteTargetTopic).toBe(topicId)
}
function persisted() { return JSON.parse(localStorage.getItem(savedMoteKey)!) }
function removeNeighbor() {
  const { [neighborTab.id]: removed, ...tabs } = useAppStore.getState().tabs
  expect(removed).toBe(neighborTab)
  useAppStore.setState({ tabs, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(tabs)) } })
}
function button(text: string, owner: ParentNode = document) {
  const found = Array.from(owner.querySelectorAll<HTMLButtonElement>('button')).find(one => one.textContent === text)
  expect(found).not.toBeUndefined(); return found!
}
async function closeSelected(keep = true) {
  const id = app.panel().dataset.moteTargetTab
  expect(id).toBeTruthy()
  const close = app.panel().querySelector<HTMLElement>(`button[data-workbench-tab-id="${id}"] .workbench-tab__close`)
  expect(close).not.toBeNull(); await moteClick(close!)
  await moteClick(button(keep ? 'Keep Session & Close' : 'Stop & Close'))
}
async function choose(topicId: string) {
  const choice = app.panel().querySelector<HTMLButtonElement>(`[data-mote-topic-id="${topicId}"]`)
  expect(choice).not.toBeNull(); await moteClick(choice!)
}
function expectQuiet(before: ReturnType<typeof useAppStore.getState>, stop: MockInstance<typeof api.sessions.stop>) {
  const after = useAppStore.getState()
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentFocus.execution).toEqual(before.agentFocus.execution)
  expect(after.tabs[customTab.id]).toBe(before.tabs[customTab.id])
  expect(after.agentComposerDrafts).toEqual(before.agentComposerDrafts)
  expect(stop).not.toHaveBeenCalled()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
}

const thirdTab = { ...createWorkbenchTab('third-mote-tab', { kind: 'launcher', regionId: 'third-mote-region',
  workspaceId: SCRATCH_WORKSPACE_ID }, 'Third original discussion'), topicId: PMO_TEAMS_TOPIC_ID }
const defaultReference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: defaultTab.id,
  regionId: defaultTab.layout.activeRegionId }

function expectOriginalTabRow(ids: string[], selected: string | null = null) {
  const tabs = Array.from(app.panel().querySelectorAll<HTMLButtonElement>('button[data-workbench-tab-id]'))
  expect([...new Set(tabs.map(tab => tab.dataset.workbenchTabId))].sort()).toEqual([...ids].sort())
  expect(tabs.filter(tab => tab.classList.contains('workbench-tab--active')).map(tab => tab.dataset.workbenchTabId)).toEqual(selected ? [selected] : [])
  const rows = Array.from(app.panel().querySelectorAll<HTMLElement>('.pane-tabbar')).filter(row => row.querySelector('.workbench-tab-strip'))
  expect(rows.length).toBeGreaterThan(0)
  let creationCount = 0
  for (const row of rows) {
    const strip = row.querySelector('.workbench-tab-strip')!
    const create = row.querySelectorAll<HTMLButtonElement>('button[aria-label="New discussion"]')
    const group = row.closest('[data-pane-group-id]') ?? (row.hasAttribute('data-workbench-group-id') ? row : null)
    // Unplaced navigation has no invented Group to receive a new discussion.
    expect(create).toHaveLength(group ? 1 : 0)
    if (!group) continue
    creationCount++
    expect(create[0]!.closest('.workbench-tab-strip')).toBe(strip)
    expect(create[0]!.closest('.pane-tabbar__actions')).toBeNull()
    expect(create[0]!.classList.contains('pane-action')).toBe(true)
    expect(create[0]!.querySelector('svg')).not.toBeNull()
    expect(create[0]!.textContent).toBe('')
    expect(create[0]!.title).toBe('New discussion')
    expect(strip.querySelector('.pane-tabbar__tabs')!.lastElementChild).toBe(create[0])
  }
  // No second row of workaround discussion buttons or creation controls.
  expect(app.panel().querySelectorAll('button[aria-label="New discussion"]')).toHaveLength(creationCount)
  return tabs
}

it('actual App three Mote Tabs → original X/Keep Session & Close keeps both remaining Tabs in the original strip and uses the closing Group', async () => {
  const state = useAppStore.getState()
  const closing = createWorkspaceLayout('mote-group', [defaultTab.id, neighborTab.id, thirdTab.id])
  closing.groups[0]!.recentTabIds = [thirdTab.id, neighborTab.id, defaultTab.id]
  const background = createWorkspaceLayout('background-group', [customTab.id])
  useAppStore.setState({ tabs: { ...state.tabs, [thirdTab.id]: thirdTab }, layouts: { ...state.layouts,
    [SCRATCH_WORKSPACE_ID]: { root: { type: 'split', direction: 'horizontal', ratio: 0.5,
      first: closing.root, second: background.root }, groups: [...closing.groups, ...background.groups], activeGroupId: 'background-group' } } })
  useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'background-group', customTab.id, 'local')
  useAppStore.getState().setMainSurface('board')
  await openSavedTarget(defaultTab.id, PMO_TEAMS_TOPIC_ID, defaultReference)
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  expectOriginalTabRow([defaultTab.id, thirdTab.id, neighborTab.id], defaultTab.id)
  await closeSelected()
  const after = useAppStore.getState()
  expect(after.tabs[defaultTab.id]).toBeUndefined()
  expect(after.tabs[thirdTab.id]).toBe(thirdTab)
  expect(after.tabs[neighborTab.id]).toBe(neighborTab)
  expect(after.layouts[SCRATCH_WORKSPACE_ID]!.activeGroupId).toBe('background-group')
  expect(after.layouts[SCRATCH_WORKSPACE_ID]!.groups.find(group => group.id === 'mote-group')!.tabOrder).toEqual([neighborTab.id, thirdTab.id])
  expect(persisted()).toMatchObject({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: neighborTab.id,
    reference: { ...defaultReference, tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId } })
  expectOriginalTabRow([thirdTab.id, neighborTab.id], neighborTab.id)
  expect(app.panel().querySelector('[data-mote-empty-space]')).toBeNull()
  expect(app.panel().textContent).not.toContain('What’s on your mind?')
  await moteClick(app.panel().querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${thirdTab.id}"]`)!)
  expect(persisted().reference).toEqual({ ...defaultReference, tabId: thirdTab.id, regionId: thirdTab.layout.activeRegionId })
  expectOriginalTabRow([thirdTab.id, neighborTab.id], thirdTab.id)
  expectQuiet(before, stop)
})

it.each([false, true])('a removed closing Group retains unselected original navigation with duplicate occurrence=$0', async duplicate => {
  const state = useAppStore.getState(), closing = createWorkspaceLayout('mote-group', [defaultTab.id])
  const remaining = createWorkspaceLayout('remaining-group', [neighborTab.id, thirdTab.id])
  const background = createWorkspaceLayout('background-group', [customTab.id, ...(duplicate ? [neighborTab.id] : [])])
  useAppStore.setState({ tabs: { ...state.tabs, [thirdTab.id]: thirdTab }, layouts: { ...state.layouts,
    [SCRATCH_WORKSPACE_ID]: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: closing.root,
      second: { type: 'split', direction: 'horizontal', ratio: 0.5, first: remaining.root, second: background.root } },
      groups: [...closing.groups, ...remaining.groups, ...background.groups], activeGroupId: 'background-group' } } })
  useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'background-group', customTab.id, 'local')
  useAppStore.getState().setMainSurface('board')
  await openSavedTarget(defaultTab.id, PMO_TEAMS_TOPIC_ID, defaultReference)
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  await closeSelected()
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups.some(group => group.id === 'mote-group')).toBe(false)
  expect(persisted().targetTabId).toBeNull()
  expect(persisted().reference).toBeUndefined()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expectOriginalTabRow([neighborTab.id, thirdTab.id])
  expect(app.panel().querySelector('.workbench-tab-slot')).toBeNull()
  const choice = app.panel().querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${thirdTab.id}"]`)!
  await moteClick(choice)
  expect(persisted().reference).toEqual({ displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'remaining-group',
    tabId: thirdTab.id, regionId: thirdTab.layout.activeRegionId })
  expectQuiet(before, stop)
})

it('closing the last Tab in its Group leaves one other-Group Tab reachable but explicitly unselected', async () => {
  const state = useAppStore.getState(), closing = createWorkspaceLayout('mote-group', [defaultTab.id])
  const remaining = createWorkspaceLayout('remaining-group', [neighborTab.id, customTab.id])
  useAppStore.setState({ mainSurface: 'board', layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: {
    root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: closing.root, second: remaining.root },
    groups: [...closing.groups, ...remaining.groups], activeGroupId: 'remaining-group' } } })
  await openSavedTarget(defaultTab.id, PMO_TEAMS_TOPIC_ID, defaultReference)
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  await closeSelected()
  expect(persisted().targetTabId).toBeNull()
  expect(persisted().reference).toBeUndefined()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expectOriginalTabRow([neighborTab.id])
  expect(app.panel().querySelector('.workbench-tab-slot')).toBeNull()
  expect(app.panel().querySelector('[data-mote-empty-space]')).toBeNull()
  expectQuiet(before, stop)
})

it('an obsolete held reference cannot redirect a committed close away from its exact original Group', async () => {
  const state = useAppStore.getState(), closing = createWorkspaceLayout('mote-group', [defaultTab.id, neighborTab.id])
  const old = createWorkspaceLayout('obsolete-group', [thirdTab.id])
  useAppStore.setState({ mainSurface: 'board', tabs: { ...state.tabs, [thirdTab.id]: thirdTab },
    layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: {
      root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: closing.root, second: old.root },
      groups: [...closing.groups, ...old.groups], activeGroupId: 'obsolete-group' } } })
  await openSavedTarget(defaultTab.id, PMO_TEAMS_TOPIC_ID, { ...defaultReference, groupId: 'obsolete-group' })
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  expect(persisted().reference.groupId).toBe('obsolete-group')
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id, { keepAgentSessions: true })).toBe(true) })
  await settleMoteApp()
  expect(persisted()).toMatchObject({ targetTabId: neighborTab.id, reference: {
    ...defaultReference, tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId } })
  expect(useAppStore.getState().tabs[thirdTab.id]).toBe(thirdTab)
  expectOriginalTabRow([neighborTab.id, thirdTab.id], neighborTab.id)
  expectQuiet(before, stop)
})

it('original members stay navigable on the first render without any stored or retained display layout', async () => {
  const state = useAppStore.getState(), { [SCRATCH_WORKSPACE_ID]: removed, ...layouts } = state.layouts
  expect(removed).toBeDefined()
  useAppStore.setState({ mainSurface: 'board', layouts })
  await openSavedTarget(null)
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  expectOriginalTabRow([defaultTab.id, neighborTab.id])
  expect(persisted().targetTabId).toBeNull()
  expect(app.panel().querySelector('.workbench-tab-slot')).toBeNull()
  expect(app.panel().querySelector('[data-mote-empty-space]')).toBeNull()
  expect(app.panel().querySelector('[aria-label="New discussion"]')).toBeNull()
  expect(app.panel().textContent).toContain('Their display layout is not confirmed yet')
  await moteClick(app.panel().querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${neighborTab.id}"]`)!)
  expect(persisted().targetTabId).toBe(neighborTab.id)
  expect(persisted().reference).toBeNull()
  expect(app.panel().textContent).toContain('Original Tab retained')
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expectQuiet(before, stop)
})

it('raw unloaded layout members keep empty-Mote creation unavailable until actual member facts arrive', async () => {
  const state = useAppStore.getState(), { [defaultTab.id]: first, [neighborTab.id]: second, ...tabs } = state.tabs
  expect(first).toBe(defaultTab); expect(second).toBe(neighborTab)
  const layout = createWorkspaceLayout('mote-group', ['original-member-not-loaded', customTab.id])
  useAppStore.setState({ mainSurface: 'board', tabs, layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: layout } })
  await openSavedTarget(null)
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  expect(persisted().targetTabId).toBeNull()
  expect(app.panel().querySelector('[data-mote-empty-space]')).toBeNull()
  expect(app.panel().querySelector('[aria-label="New discussion"]')).toBeNull()
  expect(app.panel().textContent).toContain('Workspace members are still restoring')
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.tabOrder).toEqual(['original-member-not-loaded', customTab.id])
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expectQuiet(before, stop)
})

it.each(['unplaced', 'other-display', 'ambiguous-display'] as const)('saved null exposes original $0 Tabs without inventing a location and recovers only an explicit choice', async location => {
  const state = useAppStore.getState()
  const external = createWorkspaceLayout('external-group', [defaultTab.id, neighborTab.id])
  if (location === 'ambiguous-display') {
    const second = createWorkspaceLayout('second-external-group', [neighborTab.id])
    external.root = { type: 'split', direction: 'horizontal', ratio: 0.5, first: external.root, second: second.root }
    external.groups.push(...second.groups)
  }
  useAppStore.setState({ mainSurface: 'board', layouts: { ...state.layouts,
    [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [customTab.id]),
    ...(location !== 'unplaced' ? { project: external } : {}) } })
  await openSavedTarget(null)
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  expect(persisted().targetTabId).toBeNull()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expectOriginalTabRow([defaultTab.id, neighborTab.id])
  expect(app.panel().querySelector('.workbench-tab-slot')).toBeNull()
  expect(app.panel().querySelector('[data-mote-empty-space]')).toBeNull()
  await moteClick(app.panel().querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${neighborTab.id}"]`)!)
  expect(persisted().targetTabId).toBe(neighborTab.id)
  if (location === 'other-display') {
    expect(persisted().reference).toEqual({ displayWorkspaceId: 'project', groupId: 'external-group',
      tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId })
    expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
  } else {
    expect(persisted().reference).toBeNull()
    expect(app.panel().textContent).toContain('Original Tab retained')
    if (location === 'unplaced') expect(app.panel().textContent).toContain('Group placement is not confirmed')
    else {
      expect(app.panel().textContent).toContain('The exact discussion location is not confirmed')
      const choices = Array.from(app.panel().querySelectorAll<HTMLButtonElement>('button')).filter(choice => choice.textContent?.endsWith('· Location 2'))
      expect(choices).toHaveLength(1)
      await moteClick(choices[0]!)
      expect(persisted().reference).toEqual({ displayWorkspaceId: 'project', groupId: 'second-external-group',
        tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId })
    }
  }
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expectQuiet(before, stop)
})

it('an unavailable current layout cannot claim an empty Mote from its retained old layout or create a discussion', async () => {
  removeNeighbor()
  await openSavedTarget()
  await closeSelected()
  expect(persisted().targetTabId).toBeNull()
  const before = useAppStore.getState()
  const { [SCRATCH_WORKSPACE_ID]: originalLayout, ...layouts } = before.layouts
  expect(originalLayout).toBeDefined()
  await act(async () => useAppStore.setState({ layouts })); await settleMoteApp()
  expect(app.panel().querySelector('[data-mote-empty-space]')).toBeNull()
  expect(app.panel().querySelector('[aria-label="New discussion"]')).toBeNull()
  expect(app.panel().textContent).toContain('still restoring')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(app.launch).not.toHaveBeenCalled()
})

it('actual App Tab X → Keep Session & Close selects the same Mote original remaining Tab', async () => {
  await openSavedTarget()
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  expect([defaultTab.id, neighborTab.id].map(id => before.tabs[id])).toEqual([defaultTab, neighborTab])
  await closeSelected()
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
  expect(useAppStore.getState().tabs[neighborTab.id]).toBe(before.tabs[neighborTab.id])
  expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
  expect(persisted().targetTabId).toBe(neighborTab.id)
  expect(app.panel().textContent).not.toContain('Original Tab retained')
  expectQuiet(before, stop)
})

it('last actual Tab close persists null, survives remount and Mote switching, and creates only via explicit New discussion', async () => {
  removeNeighbor(); await openSavedTarget()
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  await closeSelected()
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
  expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)).toEqual([])
  expect(persisted().targetTabId).toBeNull()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(app.panel().textContent).not.toContain('Original Tab retained')
  expectQuiet(before, stop)
  await app.remount()
  expect(persisted().targetTabId).toBeNull()
  await choose(customMoteId); expect(app.panel().dataset.moteTargetTab).toBe(customTab.id)
  await choose(PMO_TEAMS_TOPIC_ID)
  expect(persisted().targetTabId).toBeNull()
  expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)).toEqual([])
  const newTab = app.panel().querySelector<HTMLButtonElement>('button[aria-label="New discussion"]')
  expect(newTab).not.toBeNull(); await moteClick(newTab!)
  const created = Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)
  expect(created).toHaveLength(1)
  expect(created[0]!.id).not.toBe(defaultTab.id)
  expect(created[0]!.regions[created[0]!.layout.activeRegionId]!.kind).toBe('launcher')
  expect(app.panel().dataset.moteTargetTab).toBe(created[0]!.id)
  expectQuiet(before, stop)
})

it('empty Open in Space selects the same Topic without preparing a launcher', async () => {
  removeNeighbor(); await openSavedTarget(); await closeSelected()
  expect(persisted().targetTabId).toBeNull()
  const before = useAppStore.getState()
  const open = app.panel().querySelector<HTMLButtonElement>('button[aria-label="Open in Space"]')
  expect(open).not.toBeNull(); await moteClick(open!)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().workbenchSpaceSelection?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(useAppStore.getState().workbenchSpaceSelection?.tabId).toBeNull()
  expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
  const empty = document.querySelector<HTMLElement>(`[data-mote-empty-space="${PMO_TEAMS_TOPIC_ID}"]`)
  expect(empty).not.toBeNull()
  expect(empty!.textContent).toContain('Mote')
  expect(empty!.querySelector('[role="status"]')?.textContent).toBe('What’s on your mind?')
  const create = empty!.querySelector<HTMLButtonElement>('[aria-label="New discussion"]')
  expect(create).not.toBeNull(); await moteClick(create!)
  const created = Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)
  expect(created).toHaveLength(1)
  expect(created[0]!.id).not.toBe(defaultTab.id)
  expect(created[0]!.regions[created[0]!.layout.activeRegionId]!.kind).toBe('launcher')
  expect(useAppStore.getState().tabs[customTab.id]).toBe(before.tabs[customTab.id])
  expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
  expect(app.launch).not.toHaveBeenCalled()
})

it('empty Mote follows its exact original home while multiple Zones bind the same Topic', async () => {
  removeNeighbor(); await openSavedTarget(); await closeSelected()
  expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)).toEqual([])
  const before = useAppStore.getState()
  const sources = spatialSources(before.config, moteTopics, before.spaceZoneBindings)
  const space = sources.spaces.find(one => one.topicId === PMO_TEAMS_TOPIC_ID)!
  expect(space).toBeDefined()
  const originalHome = homeZoneId(space.spaceId)
  const decoy = 'retained-mote-foreign-zone'
  useAppStore.setState({ spaceZoneBindings: { ...before.spaceZoneBindings,
    [decoy]: { spaceId: space.spaceId, workspaceId: SCRATCH_WORKSPACE_ID,
      relations: { [space.spaceId]: true } },
    [originalHome]: { spaceId: space.spaceId, workspaceId: SCRATCH_WORKSPACE_ID,
      relations: { [space.spaceId]: true, [directoryIdentity(space.hostId, _hygiene_fixturePath("other-topic"))]: true } }
  } })
  const open = app.panel().querySelector<HTMLButtonElement>('button[aria-label="Open in Space"]')
  expect(open).not.toBeNull(); await moteClick(open!)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({
    spaceId: space.spaceId, zoneId: originalHome, topicId: PMO_TEAMS_TOPIC_ID, tabId: null
  })
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
  expect(app.launch).not.toHaveBeenCalled()
})

it('an unbound original Mote home stays unknown instead of borrowing another Topic binding', async () => {
  await openSavedTarget(null)
  const before = useAppStore.getState()
  const space = spatialSources(before.config, moteTopics, before.spaceZoneBindings).spaces.find(one => one.topicId === PMO_TEAMS_TOPIC_ID)!
  expect(space).toBeDefined()
  useAppStore.setState({ spaceZoneBindings: { ...before.spaceZoneBindings,
    [homeZoneId(space.spaceId)]: { spaceId: space.spaceId, workspaceId: SCRATCH_WORKSPACE_ID,
      relations: { [space.spaceId]: false } },
    'retained-mote-other-binding': { spaceId: space.spaceId, workspaceId: SCRATCH_WORKSPACE_ID,
      relations: { [space.spaceId]: true } }
  } })
  const execute = vi.spyOn(useAppStore.getState(), 'executeControl')
  const report = useAppStore.getState().reportError
  const open = app.panel().querySelector<HTMLButtonElement>('button[aria-label="Open in Space"]')
  expect(open).not.toBeNull(); await moteClick(open!)
  expect(execute).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'The original Mote Space is not available' }))
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
  expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
  expect(app.launch).not.toHaveBeenCalled()
})

it('saved explicit null keeps every original Tab reachable without selecting, creating or starting one', async () => {
  expect([defaultTab.id, neighborTab.id].map(id => useAppStore.getState().tabs[id])).toEqual([defaultTab, neighborTab])
  await openSavedTarget(null)
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(persisted().targetTabId).toBeNull()
  expectOriginalTabRow([defaultTab.id, neighborTab.id])
  expect(app.panel().querySelector('[data-mote-empty-space]')).toBeNull()
  expect(app.panel().textContent).not.toContain('What’s on your mind?')
  expect(app.panel().querySelector('.workbench-tab-slot')).toBeNull()
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  const before = useAppStore.getState()
  await app.remount()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(persisted().targetTabId).toBeNull()
  expectOriginalTabRow([defaultTab.id, neighborTab.id])
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled()
  expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
  const create = app.panel().querySelector<HTMLButtonElement>('.pane-tabbar button[aria-label="New discussion"]')!
  await moteClick(create)
  const added = Object.values(useAppStore.getState().tabs).filter(tab => !before.tabs[tab.id])
  expect(added).toHaveLength(1)
  expect(added[0]!.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(added[0]!.regions[added[0]!.layout.activeRegionId]!.kind).toBe('launcher')
  expect(persisted().reference).toEqual({ displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group',
    tabId: added[0]!.id, regionId: added[0]!.layout.activeRegionId })
  expectOriginalTabRow([defaultTab.id, neighborTab.id, added[0]!.id], added[0]!.id)
  expect(app.launch).not.toHaveBeenCalled()
})

it('an unconfirmed Topic with no target keeps the preparation notice without claiming an empty workface', async () => {
  await openSavedTarget(null, 'launcher:not-confirmed')
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(app.panel().textContent).toContain('Topic directory is still being confirmed')
  expect(app.panel().querySelector('[data-mote-empty-space]')).toBeNull()
  expect(app.panel().textContent).not.toContain('What’s on your mind?')
  expect(app.panel().querySelector('[aria-label="New discussion"]')).toBeNull()
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  expect(app.launch).not.toHaveBeenCalled()
  const originalSpaceId = directoryIdentity('local', _hygiene_fixturePath("topics/unconfirmed-original"))
  const unconfirmed = {
    workspaceId: SCRATCH_WORKSPACE_ID, spaceId: originalSpaceId, zoneId: homeZoneId(originalSpaceId),
    topicId: 'launcher:not-confirmed', tabId: null, groupId: null, regionId: null
  }
  await act(async () => { useAppStore.setState({ mainSurface: 'workbench', workbenchSpaceSelection: unconfirmed }) }); await settleMoteApp()
  expect(document.querySelector('[data-mote-empty-space]')).toBeNull()
  expect(document.body.textContent).toContain('The selected object or its original Zone position is not confirmed. Its workface and exact reference are kept.')
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(unconfirmed)
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
})

it('an exact custom Tab saved without Topic preference consumes its actual close in the same Topic', async () => {
  const neighbor = { ...neighborTab, id: 'custom-neighbor', topicId: customMoteId }
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [neighbor.id]: neighbor },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [...Object.keys(useAppStore.getState().tabs), neighbor.id]) } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTabId: customTab.id }))
  await app.mount()
  expect(persisted().targetTopicId).toBeUndefined()
  // The original floating owner is mounted but not pinned, so no pin-normalization has written a Topic yet.
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', customTab.id, { keepAgentSessions: true })).toBe(true) })
  expect(useAppStore.getState().tabs[customTab.id]).toBeUndefined()
  expect(useAppStore.getState().tabs[neighbor.id]).toBe(neighbor)
  expect(persisted().targetTopicId).toBe(customMoteId)
  expect(persisted().targetTabId).toBe(neighbor.id)
})

it('confirmed custom empty Topic uses only its own object name', async () => {
  const { [customTab.id]: removed, ...tabs } = useAppStore.getState().tabs
  expect(removed).toBe(customTab)
  useAppStore.setState({ tabs })
  await openSavedTarget(null, customMoteId)
  expect(app.panel().getAttribute('aria-label')).toBe(moteTopics.find(topic => topic.id === customMoteId)!.title)
  expect(app.panel().getAttribute('aria-label')).not.toContain(' · Mote')
})

it('cancel and unselected close preserve the current target; no-plan true is not a deletion', async () => {
  await openSavedTarget()
  const close = app.panel().querySelector<HTMLElement>(`button[data-workbench-tab-id="${defaultTab.id}"] .workbench-tab__close`)
  expect(close).not.toBeNull(); await moteClick(close!)
  await moteClick(button('Cancel'))
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'missing-group', defaultTab.id, { keepAgentSessions: true })).toBe(true) })
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', neighborTab.id, { keepAgentSessions: true })).toBe(true) })
  expect(useAppStore.getState().tabs[neighborTab.id]).toBeUndefined()
  expect(persisted().targetTabId).toBe(defaultTab.id)
})

it('closing one placement keeps the original Tab and floating reference', async () => {
  const layout = createWorkspaceLayout('mote-group', Object.keys(useAppStore.getState().tabs))
  // A retained group can sit outside the visible split tree; its real membership still owns the Tab.
  layout.groups.push({ ...layout.groups[0]!, id: 'other-group', tabOrder: [defaultTab.id], activeTabId: defaultTab.id, recentTabIds: [defaultTab.id] })
  useAppStore.setState({ layouts: { [SCRATCH_WORKSPACE_ID]: layout } })
  await openSavedTarget()
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id, { keepAgentSessions: true })).toBe(true) })
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups.find(group => group.id === 'other-group')?.tabOrder).toEqual([defaultTab.id])
  expect(persisted().targetTabId).toBe(defaultTab.id)
})

it('resource close failure retains its original View and target', async () => {
  await openSavedTarget()
  const stop = vi.spyOn(api.sessions, 'stop').mockRejectedValue(new Error('Original stop failed'))
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id)).toBe(false) })
  expect(stop).toHaveBeenCalledOnce()
  expect(useAppStore.getState().tabs[defaultTab.id]?.regions['default-region']).toMatchObject({ kind: 'agent', sessionId: defaultAgent.id })
  expect(persisted().targetTabId).toBe(defaultTab.id)
  expect(useAppStore.getState().reportError).toHaveBeenCalled()
})

it('an observer failure reports the original service warning without blocking a healthy close', async () => {
  await openSavedTarget()
  const error = new Error('Original UI observer failed'), unsubscribe = subscribeWorkbenchTabRemoved(() => { throw error })
  try {
    await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id, { keepAgentSessions: true })).toBe(true) })
    expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
    expect(persisted().targetTabId).toBe(neighborTab.id)
    expect(useAppStore.getState().reportError).toHaveBeenCalledWith(error)
  } finally { unsubscribe() }
})

it('late metadata prepare does not create a closed Tab or replace a newly selected Mote', async () => {
  let release!: () => void
  app.ensureMote.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(moteTopics[0]!) }))
  await openSavedTarget()
  expect(app.ensureMote).toHaveBeenCalledOnce()
  await choose(customMoteId)
  const before = useAppStore.getState()
  await act(async () => { release() }); await settleMoteApp()
  expect(persisted().targetTabId).toBe(customTab.id)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(app.launch).not.toHaveBeenCalled()
})

it('deferred empty Topic ensure failure and Retry context preserve empty until explicit New discussion', async () => {
  const { [customTab.id]: removed, ...tabs } = useAppStore.getState().tabs
  expect(removed).toBe(customTab)
  useAppStore.setState({ tabs, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(tabs)) } })
  let fail!: (error: Error) => void
  app.ensureMote.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  await openSavedTarget(null, customMoteId)
  const before = useAppStore.getState()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  await act(async () => { fail(new Error('Original directory unavailable')) }); await settleMoteApp()
  expect(app.panel().textContent).toContain('Context preparation did not complete')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  await moteClick(button('Retry context', app.panel()))
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(app.warm).not.toHaveBeenCalled()
  const newTab = app.panel().querySelector<HTMLButtonElement>('[aria-label="New discussion"]')
  expect(newTab).not.toBeNull(); await moteClick(newTab!)
  const created = Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === customMoteId)
  expect(created).toHaveLength(1)
  expect(created[0]!.id).not.toBe(customTab.id)
  expect(created[0]!.regions[created[0]!.layout.activeRegionId]!.kind).toBe('launcher')
  expect(app.panel().dataset.moteTargetTab).toBe(created[0]!.id)
})

it('deferred metadata read failure preserves the exact existing Tab and original workface', async () => {
  let fail!: (error: Error) => void
  vi.mocked(api.scratch.readTopic).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  await openSavedTarget()
  const before = useAppStore.getState()
  expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
  await act(async () => { fail(new Error('Original Topic read failed')) }); await settleMoteApp()
  expect(app.panel().textContent).toContain('Context preparation did not complete')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(persisted().targetTabId).toBe(defaultTab.id)
  expect(app.launch).not.toHaveBeenCalled()
})

it('late closing result cannot replace a newly selected different Mote', async () => {
  await openSavedTarget()
  let finish!: () => void
  vi.spyOn(api.sessions, 'stop').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  let pending!: Promise<boolean>
  await act(async () => { pending = useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id) })
  await choose(customMoteId)
  expect(persisted().targetTabId).toBe(customTab.id)
  await act(async () => { finish(); expect(await pending).toBe(true) })
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
  expect(persisted().targetTabId).toBe(customTab.id)
})

it('a Run replacement during close retains the changed View and original target', async () => {
  await openSavedTarget()
  let finish!: () => void
  vi.spyOn(api.sessions, 'stop').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  let pending!: Promise<boolean>
  await act(async () => {
    pending = useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id)
    useAppStore.setState({ sessions: useAppStore.getState().sessions.map(session => session.id === defaultAgent.id
      ? { ...defaultAgent, control: { ...defaultAgent.control, run: { runId: 'replacement-run' } } } : session) })
  })
  await act(async () => { finish(); expect(await pending).toBe(false) })
  expect(useAppStore.getState().tabs[defaultTab.id]?.regions['default-region']).toMatchObject({ kind: 'agent', sessionId: defaultAgent.id })
  expect(persisted().targetTabId).toBe(defaultTab.id)
})

it('post-delete file cleanup failure reports its error and still consumes the committed deletion', async () => {
  const file = { ...createWorkbenchTab('file-tab', { regionId: 'file-region', workspaceId: SCRATCH_WORKSPACE_ID, kind: 'file', path: _hygiene_fixturePath("topics/document.md") }), topicId: PMO_TEAMS_TOPIC_ID }
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [file.id]: file },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [file.id, neighborTab.id, customTab.id]) } })
  await openSavedTarget(file.id)
  const error = new Error('Original file unobserve failed')
  vi.spyOn(api.files, 'unobserve').mockRejectedValue(error)
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', file.id)).toBe(false) })
  expect(useAppStore.getState().tabs[file.id]).toBeUndefined()
  expect(useAppStore.getState().reportError).toHaveBeenCalledWith(error)
  expect(persisted().targetTabId).toBe(neighborTab.id)
})

it.each(['missing', 'other-topic', 'other-workspace', 'unplaced'] as const)('keeps exact %s saved target as unknown recovery', async kind => {
  const { [defaultTab.id]: removed, ...tabs } = useAppStore.getState().tabs
  expect(removed).toBe(defaultTab)
  if (kind === 'other-topic') tabs[defaultTab.id] = { ...defaultTab, topicId: customMoteId }
  if (kind === 'other-workspace') tabs[defaultTab.id] = { ...defaultTab, workspaceId: 'project' }
  if (kind === 'unplaced') tabs[defaultTab.id] = defaultTab
  useAppStore.setState({ tabs, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [neighborTab.id, customTab.id]) } })
  await openSavedTarget()
  expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
  expect(persisted().targetTabId).toBe(defaultTab.id)
  expect(app.panel().textContent).toContain('Original Tab retained')
  expect(useAppStore.getState().tabs[neighborTab.id]).toBe(neighborTab)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
