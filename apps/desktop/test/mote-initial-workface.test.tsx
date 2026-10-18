// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customTab, customAgent, customMoteId, defaultTab, defaultAgent, neighborTab, savedMoteKey } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'

let app: MoteAppFixture
beforeEach(() => {
  app = createMoteApp()
  useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: 'project', projectRailOpen: true,
    workbenchSpaceSelection: null, retainedSpatialFocus: null, spaceZoneBindings: {},
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [customTab.id]), project: createWorkspaceLayout('project-group') } })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'observe').mockResolvedValue()
  vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
afterEach(async () => { await app.dispose() })
const main = () => app.container.querySelector<HTMLElement>('.workspace-workbench-slot[data-workspace-id="' + SCRATCH_WORKSPACE_ID + '"]')!
async function openDirectory() {
  await app.mount()
  const button = app.container.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + PMO_TEAMS_TOPIC_ID + '"]')
  expect(button, 'The real Space Mote directory action must be available').not.toBeNull()
  await moteClick(button!)
}
function expectOriginalWork(before: ReturnType<typeof useAppStore.getState>) {
  const current = useAppStore.getState()
  expect(current.tabs).toBe(before.tabs)
  const executionFacts = (state: ReturnType<typeof useAppStore.getState>) => state.sessions.map(session =>
    [session.id, session.hostId, session.workspacePath, session.processState, session.control])
  expect(executionFacts(current)).toEqual(executionFacts(before))
  expect(current.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(current.tabs[customTab.id]).toBe(before.tabs[customTab.id])
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
}

it('clicking an empty Mote directory loads its initial page without creating a Tab or Session', async () => {
  const { [defaultTab.id]: first, [neighborTab.id]: second, ...tabs } = useAppStore.getState().tabs
  expect(first).toBe(defaultTab); expect(second).toBe(neighborTab)
  useAppStore.setState({ tabs })
  const before = useAppStore.getState()
  await openDirectory()
  expect(main()?.querySelector('[data-mote-empty-space]')).not.toBeNull()
  expect(main()?.textContent).toContain('What’s on your mind?')
  expect(main()?.textContent).not.toContain('Original work surface retained')
  expectOriginalWork(before)
})

it('clicking a Mote directory loads existing unplaced members without requiring display occurrences', async () => {
  const before = useAppStore.getState()
  await openDirectory()
  expect(main()?.textContent).not.toContain('This original entity has no confirmed display occurrence here')
  expect(main()?.querySelector('[data-workbench-tab-id="' + defaultTab.id + '"]')).not.toBeNull()
  expect(main()?.querySelector('[data-workbench-tab-id="' + neighborTab.id + '"]')).not.toBeNull()
  expect(main()?.querySelector('[data-mote-empty-space]')).toBeNull()
  expectOriginalWork(before)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
})

it('clicking the compact Mote entry loads the same unplaced members without changing the original layout', async () => {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null }))
  const before = useAppStore.getState()
  await app.mount(); await moteClick(app.entry()); await settleMoteApp()
  expect(app.panel().textContent).not.toContain('This original entity has no confirmed display occurrence here')
  expect(app.panel().querySelector('[data-workbench-tab-id="' + defaultTab.id + '"]')).not.toBeNull()
  expect(app.panel().querySelector('[data-workbench-tab-id="' + neighborTab.id + '"]')).not.toBeNull()
  expectOriginalWork(before)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
})

const tabButton = (tabId: string) => main().querySelector<HTMLButtonElement>('button[data-workbench-tab-id="' + tabId + '"]')!
const inputFor = (tabId: string) => main().querySelector<HTMLElement>('.workbench-tab-slot[data-workbench-tab-id="' + tabId + '"] [aria-label="Message Agent"]')!

it('switches original unplaced conversations and edits only the selected original draft while other bodies stay mounted', async () => {
  await app.mount()
  await moteClick(app.container.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + customMoteId + '"]')!)
  const parkedSelector = '[data-activity-session="' + customAgent.id + '"], [data-terminal-session="' + customAgent.id + '"]'
  const parkedBody = app.container.querySelector(parkedSelector)
  expect(parkedBody).not.toBeNull()
  const before = useAppStore.getState()
  await moteClick(app.container.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + PMO_TEAMS_TOPIC_ID + '"]')!)
  await moteClick(tabButton(defaultTab.id))
  expect(tabButton(defaultTab.id).classList.contains('workbench-tab--active')).toBe(true)
  expect(inputFor(defaultTab.id)?.textContent).toContain('Default unsent')
  const input = inputFor(defaultTab.id)
  await moteType(input, 'Keep this original draft')
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toContain('Keep this original draft')
  expect(useAppStore.getState().agentComposerDrafts[customAgent.id]).toBe(before.agentComposerDrafts[customAgent.id])
  await moteClick(tabButton(neighborTab.id))
  expect(tabButton(neighborTab.id).classList.contains('workbench-tab--active')).toBe(true)
  expect(inputFor(neighborTab.id)).not.toBeNull()
  await moteClick(tabButton(defaultTab.id))
  expect(inputFor(defaultTab.id)).toBe(input)
  expect(inputFor(defaultTab.id).textContent).toContain('Keep this original draft')
  expect(app.container.querySelector(parkedSelector)).toBe(parkedBody)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('moves between placed and unplaced members without inventing a durable display occurrence', async () => {
  useAppStore.setState({ layouts: { ...useAppStore.getState().layouts,
    [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [customTab.id, defaultTab.id]) } })
  const before = useAppStore.getState()
  await openDirectory()
  const loadedLayouts = useAppStore.getState().layouts
  await moteClick(tabButton(neighborTab.id))
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: null, groupId: null, regionId: null })
  expect(tabButton(neighborTab.id).classList.contains('workbench-tab--active')).toBe(true)
  await moteClick(tabButton(defaultTab.id))
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: defaultTab.id, groupId: 'mote-group', regionId: 'default-region' })
  expect(inputFor(defaultTab.id)?.textContent).toContain('Default unsent')
  expect(main().textContent).not.toContain('Original work surface retained')
  expectOriginalWork(before)
  expect(useAppStore.getState().layouts).toEqual(loadedLayouts)
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]?.groups.map(group => [group.id, group.tabOrder])).toEqual(
    before.layouts[SCRATCH_WORKSPACE_ID]?.groups.map(group => [group.id, group.tabOrder]))
})

it('creates a discussion through the original Zone owner from its direct presentation group', async () => {
  await openDirectory()
  const before = useAppStore.getState()
  const create = main().querySelector<HTMLButtonElement>('[aria-label="New discussion"]')
  expect(create).not.toBeNull()
  await moteClick(create!)
  const state = useAppStore.getState(), added = Object.values(state.tabs).filter(tab => !before.tabs[tab.id])
  expect(added).toHaveLength(1)
  const tab = added[0]!
  expect(tab.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(Object.values(tab.regions).map(region => region.kind)).toEqual(['launcher'])
  expect(state.layouts[SCRATCH_WORKSPACE_ID]?.groups.some(group => group.tabOrder.includes(tab.id))).toBe(true)
  expect(tabButton(tab.id)?.classList.contains('workbench-tab--active')).toBe(true)
  expect(state.tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id]); expect(state.tabs[neighborTab.id]).toBe(before.tabs[neighborTab.id])
  expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('keeps repeated physical members and resizes their original split without writing the synthetic split', async () => {
  const direct = { ...createWorkbenchTab('direct-tab', { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID,
    regionId: 'direct-region' }, 'Direct discussion'), topicId: PMO_TEAMS_TOPIC_ID }
  const first = createWorkspaceLayout('first', [defaultTab.id]), second = createWorkspaceLayout('second', [neighborTab.id, defaultTab.id])
  const original = { root: { type: 'split' as const, direction: 'horizontal' as const, ratio: 0.3, first: first.root, second: second.root },
    groups: [...first.groups, ...second.groups], activeGroupId: 'first' }
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [direct.id]: direct },
    layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: original } })
  await openDirectory()
  expect(main().querySelectorAll('button[data-workbench-tab-id="' + defaultTab.id + '"]')).toHaveLength(2)
  expect(tabButton(direct.id)).not.toBeNull()
  expect(main().textContent).not.toContain('Simultaneous live presentation is not available')
  const handles = main().querySelectorAll<HTMLElement>('[aria-label="Resize split"]')
  expect(handles).toHaveLength(2)
  const update = vi.spyOn(useAppStore.getState(), 'updateSplitRatio')
  const loadedOriginal = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]
  // DOM order: original inner split, then the synthetic composition split.
  await act(async () => handles[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  await settleMoteApp()
  expect(update).not.toHaveBeenCalled()
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toBe(loadedOriginal)
  await act(async () => handles[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await settleMoteApp()
  expect(update).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, '', 0.5)
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]?.root).toMatchObject({ ratio: 0.5 })
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]?.groups).toEqual(original.groups)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
