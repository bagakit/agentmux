// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborTab, quietMoteId, quietTab, ordinaryTopicId, ordinaryTab, savedMoteKey, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicIdentityPath } from '../src/shared/scratch-topics'
import { directoryIdentity } from '../src/shared/space-addresses'
import { requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp(); useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: true } }) })
afterEach(async () => { await app.dispose() })
function shortcut() {
  const actions = [...app.panel().querySelectorAll<HTMLButtonElement>('[aria-label="Open in Space"]')]
  expect(actions).toHaveLength(1)
  return actions[0]!
}
function originalFacts() {
  const state = useAppStore.getState()
  return { tabs: state.tabs, sessions: state.sessions, drafts: state.agentComposerDrafts, modes: state.viewModes }
}
function expectOriginal(facts: ReturnType<typeof originalFacts>) {
  const state = useAppStore.getState()
  expect(state.tabs).toStrictEqual(facts.tabs); expect(state.sessions).toBe(facts.sessions)
  expect(state.agentComposerDrafts).toBe(facts.drafts); expect(state.viewModes).toBe(facts.modes)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
}
async function float(tabId: string | null = defaultTab.id, topicId = PMO_TEAMS_TOPIC_ID) {
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, targetTabId: tabId }))
  await settleMoteApp()
}

describe('original public Tab action hands a Mote to its exact Space', () => {
  it('uses the second complete occurrence and canonical Mote Space without changing the original entities or drafts', async () => {
    const state = useAppStore.getState(), first = state.layouts[SCRATCH_WORKSPACE_ID]!
    const second = createWorkspaceLayout('second-shortcut-group', [defaultTab.id])
    const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: second.activeGroupId, tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board', layouts: { ...state.layouts,
      [SCRATCH_WORKSPACE_ID]: { ...first, root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
        groups: [...first.groups, ...second.groups] } } })
    localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, reference }))
    const owner = vi.spyOn(useAppStore.getState(), 'executeControl') // Forward the actual public Store/Core focus owner.
    await app.mount()
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull(); expect(input.textContent).toContain('Default unsent')
    expect(app.panel().querySelector('.mote-workface__tools, .mote-workface__files, [data-mote-details]')).toBeNull()
    expect(app.panel().querySelector('[aria-label="Mote files"], [aria-label="Open Mote Space"]')).toBeNull()
    const action = shortcut()
    expect(action.closest('.pane-tabbar__actions')).not.toBeNull()
    expect(action.closest<HTMLElement>('[data-pane-group-id]')?.dataset.paneGroupId).toBe(reference.groupId)
    const before = originalFacts()
    await moteClick(action)
    expect(owner).toHaveBeenCalledTimes(1)
    await act(async () => { await owner.mock.results[0]!.value }); await settleMoteApp()
    expect(owner.mock.calls[0]![0]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', target: { kind: 'space',
      spaceId: directoryIdentity(scratchWorkspace.hostId, scratchTopicIdentityPath(scratchWorkspace, moteTopics[0]!)), ...reference } })
    expect((await owner.mock.results[0]!.value).navigation.state).toMatch(/^(applied|unchanged)$/)
    const current = useAppStore.getState()
    expect(current.activeWorkspaceId).toBe(reference.displayWorkspaceId); expect(current.mainSurface).toBe('workbench')
    expect(current.workbenchSpaceSelection).toMatchObject({ workspaceId: reference.displayWorkspaceId, groupId: reference.groupId,
      tabId: reference.tabId, regionId: reference.regionId, topicId: PMO_TEAMS_TOPIC_ID })
    expect(readPmoTeamsTopicFloatingState().open).toBe(false)
    expect(app.container.querySelector('.surface-tool-dock [data-mote-details]')?.getAttribute('data-mote-details')).toBe(PMO_TEAMS_TOPIC_ID)
    expect(app.container.querySelector('[aria-label="Message Agent"]')).toBe(input)
    expectOriginal(before)
  })

  it('keeps an empty Mote empty while its original Space provides the complete secondary content', async () => {
    const original = useAppStore.getState(), { [quietTab.id]: removed, ...tabs } = original.tabs
    useAppStore.setState({ tabs, activeWorkspaceId: 'project', mainSurface: 'board', layouts: { ...original.layouts,
      [SCRATCH_WORKSPACE_ID]: { ...original.layouts[SCRATCH_WORKSPACE_ID]!, groups: original.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({ ...group,
        tabOrder: group.tabOrder.filter(id => id !== quietTab.id), activeTabId: group.activeTabId === quietTab.id ? null : group.activeTabId })) } } })
    const owner = vi.spyOn(useAppStore.getState(), 'executeControl')
    await float(null, quietMoteId)
    const before = originalFacts()
    expect(app.panel().textContent).toContain('No discussion yet')
    expect(app.panel().querySelector('.mote-workface__tools, .mote-workface__files, [data-mote-details]')).toBeNull()
    await moteClick(shortcut())
    expect(owner).toHaveBeenCalledTimes(1)
    await act(async () => { await owner.mock.results[0]!.value }); await settleMoteApp()
    expect(owner.mock.calls[0]![0]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', target: { kind: 'space' } })
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ topicId: quietMoteId, tabId: null, regionId: null })
    expect(app.container.querySelector('.surface-tool-dock [data-mote-details]')?.getAttribute('data-mote-details')).toBe(quietMoteId)
    expect(readPmoTeamsTopicFloatingState().open).toBe(false)
    expectOriginal(before)
  })

  it.each(['another Tab', 'explicitly null'] as const)('rejects a raw reference that is %s while keeping the healthy current input and raw reference', async kind => {
    const reference = kind === 'explicitly null' ? null : { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId }
    localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, reference }))
    const owner = vi.spyOn(useAppStore.getState(), 'executeControl')
    await app.mount()
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull()
    const before = originalFacts(), navigation = useAppStore.getState().workbenchSpaceSelection
    await moteClick(shortcut())
    expect(owner).not.toHaveBeenCalled()
    expect(readPmoTeamsTopicFloatingState().reference).toEqual(reference)
    expect(readPmoTeamsTopicFloatingState().open).toBe(true)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(navigation)
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(useAppStore.getState().reportError).toHaveBeenCalled()
    expectOriginal(before)
  })

  it('cancels a pending original focus request when a later navigation selects another Space', async () => {
    await float()
    let release!: (topics: typeof moteTopics) => void
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const owner = vi.spyOn(useAppStore.getState(), 'executeControl')
    await moteClick(shortcut())
    expect(owner).toHaveBeenCalledTimes(1)
    await act(async () => useAppStore.setState({ mainSurface: 'board', activeWorkspaceId: 'project' }))
    const before = originalFacts()
    await act(async () => release(moteTopics)); await settleMoteApp()
    expect(owner.mock.calls[0]![1]?.aborted).toBe(true)
    expect(useAppStore.getState().mainSurface).toBe('board'); expect(useAppStore.getState().activeWorkspaceId).toBe('project')
    expect(readPmoTeamsTopicFloatingState().open).toBe(true)
    expectOriginal(before)
  })

  it('keeps a later same-workspace Region selection while the original public focus directory read is pending', async () => {
    await float()
    let release!: (topics: typeof moteTopics) => void
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const owner = vi.spyOn(useAppStore.getState(), 'executeControl')
    await moteClick(shortcut())
    expect(owner).toHaveBeenCalledTimes(1)
    await act(async () => useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, neighborTab.id, neighborTab.layout.activeRegionId, 'pointer', 'mote-group'))
    const later = useAppStore.getState(), before = originalFacts()
    expect(later.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID); expect(later.mainSurface).toBe('workbench')
    expect(later.layouts[SCRATCH_WORKSPACE_ID]!.groups.find(group => group.id === 'mote-group')?.activeTabId).toBe(neighborTab.id)
    await act(async () => release(moteTopics))
    await act(async () => { await owner.mock.results[0]!.value }); await settleMoteApp()
    expect(owner.mock.calls[0]![1]?.aborted).toBe(true)
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups.find(group => group.id === 'mote-group')?.activeTabId).toBe(neighborTab.id)
    expect(useAppStore.getState().agentFocus).toBe(later.agentFocus)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(later.workbenchSpaceSelection)
    expect(readPmoTeamsTopicFloatingState().open).toBe(true)
    expectOriginal(before)
  })

  it.each(['Mote A→B→A', 'same-Mote discussion'] as const)('synchronously cancels a pending focus for %s before a catalog read resumes', async intent => {
    await float()
    let release!: (topics: typeof moteTopics) => void
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const owner = vi.spyOn(useAppStore.getState(), 'executeControl')
    await moteClick(shortcut())
    expect(owner).toHaveBeenCalledTimes(1)
    const signal = owner.mock.calls[0]![1]!
    expect(signal.aborted).toBe(false)
    const first = intent === 'same-Mote discussion'
      ? app.panel().querySelector<HTMLButtonElement>('button[data-workbench-tab-id="' + neighborTab.id + '"]')!
      : app.panel().querySelector<HTMLButtonElement>('[data-mote-topic-id="launcher:analyst"]')!
    expect(first).not.toBeNull()
    await act(async () => { first.click(); expect(signal.aborted).toBe(true) })
    await settleMoteApp()
    if (intent === 'Mote A→B→A') await moteClick(app.panel().querySelector<HTMLButtonElement>('[data-mote-topic-id="' + PMO_TEAMS_TOPIC_ID + '"]')!)
    const later = readPmoTeamsTopicFloatingState(), navigation = useAppStore.getState().workbenchSpaceSelection, before = originalFacts()
    await act(async () => release(moteTopics)); await settleMoteApp()
    expect(readPmoTeamsTopicFloatingState()).toEqual(later)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(navigation)
    expectOriginal(before)
  })

  it('latches a same-Tab Group A→B→A through the original floating state owner before React commits', async () => {
    const original = useAppStore.getState(), first = original.layouts[SCRATCH_WORKSPACE_ID]!, second = createWorkspaceLayout('later-shortcut-group', [defaultTab.id])
    useAppStore.setState({ layouts: { ...original.layouts, [SCRATCH_WORKSPACE_ID]: { ...first,
      root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root }, groups: [...first.groups, ...second.groups] } } })
    const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
    localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, reference }))
    let update!: ReturnType<typeof usePmoTeamsTopicFloatingState>[1]
    function OriginalFloatingStateConsumer() { [, update] = usePmoTeamsTopicFloatingState(); return null }
    await app.mount(createElement(OriginalFloatingStateConsumer))
    let release!: (topics: typeof moteTopics) => void
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const owner = vi.spyOn(useAppStore.getState(), 'executeControl')
    await moteClick(shortcut())
    const signal = owner.mock.calls[0]![1]!
    expect(signal.aborted).toBe(false)
    await act(async () => {
      update({ reference: { ...reference, groupId: second.activeGroupId } })
      update({ reference })
      expect(signal.aborted).toBe(true)
    })
    const before = originalFacts(), navigation = useAppStore.getState().workbenchSpaceSelection
    await act(async () => release(moteTopics)); await settleMoteApp()
    expect(readPmoTeamsTopicFloatingState().reference).toEqual(reference)
    expect(readPmoTeamsTopicFloatingState().open).toBe(true)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(navigation)
    expectOriginal(before)
  })

  it('leaves the ordinary Topic public Tab controls unchanged when no presentation action is supplied', async () => {
    await app.mount()
    await act(async () => useAppStore.getState().openScratchTopic(ordinaryTopicId, SCRATCH_WORKSPACE_ID, { tabId: ordinaryTab.id }))
    await settleMoteApp()
    const workbench = app.container.querySelector<HTMLElement>('[data-workspace-id="' + SCRATCH_WORKSPACE_ID + '"] > .workspace-workbench')!
    expect(workbench).not.toBeNull()
    expect(workbench.querySelector('[aria-label="Open in Space"]')).toBeNull()
    expect(workbench.querySelector('.pane-tabbar__actions [title="New tab"]')).not.toBeNull()
    expect(workbench.querySelector('[data-workbench-tab-id="' + ordinaryTab.id + '"]')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })
})
