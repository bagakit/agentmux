// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, customTab, defaultAgent, defaultTab, moteTopics, neighborAgent, neighborTab, ordinaryTopicId, ordinaryTab, savedMoteKey } from './fixtures/mote-workface'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })
function scope() {
  const node = app.container.querySelector<HTMLElement>('.workspace-workbench-registry [data-mote-workface]')
  expect(node).not.toBeNull(); return node!
}
function tabs(node: HTMLElement) { return [...node.querySelectorAll<HTMLButtonElement>('.mote-conversations button.workbench-tab')] }

describe('original Mote chat workface consumer', () => {
  it.each([['ensureMote', 'selection'], ['readTopic', 'selection'], ['ensureMote', 'unmount'], ['readTopic', 'unmount']] as const)('releases cold %s observers on %s while its original read is still pending', async (step, cancellation) => {
    useAppStore.setState({ projectRailOpen: true })
    await app.mount()
    const subscribe = useAppStore.subscribe
    const observed: { active: boolean; calls: number }[] = []
    vi.spyOn(useAppStore, 'subscribe').mockImplementation(listener => {
      const record = { active: true, calls: 0 }
      if (listener.length === 1) observed.push(record)
      const unsubscribe = subscribe((state, previous) => { record.calls++; listener(state, previous) })
      return () => { record.active = false; unsubscribe() }
    })
    let finish!: (value: typeof moteTopics[number]) => void
    const read = step === 'ensureMote' ? app.ensureMote : vi.mocked(api.scratch.readTopic)
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const row = app.container.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + customMoteId + '"]')
    expect(row).not.toBeNull()
    await moteClick(row!)
    expect(finish).toBeTypeOf('function')
    expect(observed.length).toBe(step === 'ensureMote' ? 1 : 2)
    expect(observed.filter(record => record.active)).toHaveLength(1)
    const pending = [...observed]
    if (cancellation === 'unmount') await app.remount()
    else await act(async () => useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', neighborTab.id))
    expect(pending.filter(record => record.active)).toHaveLength(0)
    const calls = pending.map(record => record.calls), later = useAppStore.getState()
    await act(async () => useAppStore.setState({ sessions: [...later.sessions] }))
    expect(pending.map(record => record.calls)).toEqual(calls)
    await act(async () => finish(moteTopics.find(topic => topic.id === customMoteId)!))
    await settleMoteApp()
    expect(useAppStore.getState().layouts).toBe(later.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(later.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('finishes the actual Space object menu New discussion action after its original focus scope closes', async () => {
    useAppStore.setState({ projectRailOpen: true })
    await app.mount()
    const row = app.container.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + customMoteId + '"]')
    expect(row).not.toBeNull()
    await act(async () => row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 20, clientY: 20 })))
    await settleMoteApp()
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'New discussion')
    expect(action).not.toBeUndefined()
    let finish!: (value: typeof moteTopics[number]) => void
    app.ensureMote.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const before = useAppStore.getState()
    await moteClick(action!)
    expect(finish).toBeTypeOf('function')
    expect(document.querySelector('[role="menu"][data-state="open"]')).toBeNull()
    await act(async () => row!.focus())
    await act(async () => finish(moteTopics.find(topic => topic.id === customMoteId)!))
    await settleMoteApp()
    const born = Object.values(useAppStore.getState().tabs).filter(tab => !before.tabs[tab.id])
    expect(born).toHaveLength(1)
    expect(born[0]!.topicId).toBe(customMoteId)
    expect(born[0]!.regions[born[0]!.layout.activeRegionId]!.kind).toBe('launcher')
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('keeps the same mounted terminal when its old Group membership disappears without claiming that old location', async () => {
    useAppStore.setState(state => ({ viewModes: { ...state.viewModes, [defaultAgent.id]: 'terminal' } }))
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
    await app.mount()
    const original = app.panel().querySelector('[data-terminal-session="default-agent"]')
    expect(original).not.toBeNull()
    expect(original!.getAttribute('data-link-origin-group')).toBe('mote-group')
    const before = useAppStore.getState()
    await act(async () => useAppStore.setState(state => ({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: {
      ...state.layouts[SCRATCH_WORKSPACE_ID]!, groups: state.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({
        ...group, tabOrder: group.tabOrder.filter(id => id !== defaultTab.id), activeTabId: neighborTab.id
      })) } } })))
    await settleMoteApp()
    expect(app.panel().querySelector('[data-terminal-session="default-agent"]')).toBe(original)
    expect(original!.hasAttribute('data-link-origin-group')).toBe(false)
    expect(app.panel().querySelector('.service-window')).not.toBeNull()
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it.each(['ensureMote', 'readTopic'] as const)('keeps a later explicit Space choice after the original %s receipt', async step => {
    useAppStore.setState({ projectRailOpen: true })
    await app.mount()
    let finish!: (value: typeof moteTopics[number]) => void
    const read = step === 'ensureMote' ? app.ensureMote : vi.mocked(api.scratch.readTopic)
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const row = app.container.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + customMoteId + '"]')
    expect(row).not.toBeNull()
    await moteClick(row!)
    expect(finish).toBeTypeOf('function')
    await act(async () => useAppStore.setState({ workbenchSpaceSelection: {
      spaceId: 'later-space', zoneId: 'later-zone', workspaceId: SCRATCH_WORKSPACE_ID,
      tabId: ordinaryTab.id, groupId: 'mote-group', regionId: 'ordinary-region', topicId: ordinaryTopicId
    }, workbenchNavigationInputPolicy: 'preserve', regionCaretFocus: null }))
    const later = useAppStore.getState()
    await act(async () => finish(moteTopics.find(topic => topic.id === customMoteId)!))
    await settleMoteApp()
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(later.workbenchSpaceSelection)
    expect(useAppStore.getState().layouts).toBe(later.layouts)
    expect(useAppStore.getState().workbenchNavigationInputPolicy).toBe(later.workbenchNavigationInputPolicy)
    expect(useAppStore.getState().agentComposerDrafts).toBe(later.agentComposerDrafts)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('keeps a missing saved reference honest and exposes original discussions for an explicit choice', async () => {
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: 'saved-unconfirmed-tab' }))
    const before = useAppStore.getState()
    await app.mount()
    expect(app.panel().dataset.moteTargetTab).toBe('saved-unconfirmed-tab')
    expect(app.panel().querySelector('.service-window')).not.toBeNull()
    expect(tabs(app.panel()).map(node => node.dataset.workbenchTabId)).toEqual([defaultTab.id, neighborTab.id])
    expect(app.panel().querySelector('[data-activity-session]')).toBeNull()
    await moteClick(tabs(app.panel())[1]!)
    expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
    expect(app.panel().querySelector('[data-activity-session="neighbor-agent"]')).not.toBeNull()
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions.map(session => ({ id: session.id, control: session.control })))
      .toEqual(before.sessions.map(session => ({ id: session.id, control: session.control })))
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
    await app.remount()
    expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
    expect(app.panel().querySelector('[data-activity-session="neighbor-agent"]')).not.toBeNull()
  })

  it.each(['activity', 'terminal'] as const)('reads the exact original %s Region when its display membership is unavailable', async mode => {
    useAppStore.setState(state => ({ layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: {
      ...state.layouts[SCRATCH_WORKSPACE_ID]!, groups: state.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({
        ...group, tabOrder: group.tabOrder.filter(id => id !== defaultTab.id), activeTabId: neighborTab.id
      })) } }, viewModes: { ...state.viewModes, [defaultAgent.id]: mode } }))
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
    const before = useAppStore.getState()
    await app.mount()
    expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
    expect(app.panel().querySelector('.service-window')).not.toBeNull()
    expect(app.panel().querySelector(`[data-${mode}-session="default-agent"]`)).not.toBeNull()
    if (mode === 'activity') expect(app.panel().querySelector('[aria-label="Message Agent"]')?.textContent).toContain('Default unsent')
    expect(tabs(app.panel()).map(node => node.dataset.workbenchTabId)).toEqual([neighborTab.id])
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('enters the actual Mote Space page from its tree row after an older explicit Space choice', async () => {
    useAppStore.setState({ projectRailOpen: true, workbenchSpaceSelection: {
      spaceId: 'original-space', zoneId: 'original-zone', workspaceId: SCRATCH_WORKSPACE_ID,
      tabId: ordinaryTab.id, groupId: 'mote-group', regionId: 'ordinary-region', topicId: ordinaryTopicId
    } })
    await app.mount()
    const row = app.container.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + PMO_TEAMS_TOPIC_ID + '"]')
    expect(row).not.toBeNull()
    const before = useAppStore.getState()
    await moteClick(row!)
    expect(app.ensureMote).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
    expect(scope().dataset.moteWorkface).toBe(PMO_TEAMS_TOPIC_ID)
    expect(tabs(scope()).map(node => node.dataset.workbenchTabId)).toEqual([defaultTab.id, neighborTab.id])
    expect(scope().querySelector('.mote-conversations__identity')?.textContent).toContain('Mote')
    expect(scope().querySelector('[aria-label="Message Agent"]')?.textContent).toContain('Default unsent')
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  })

  it('gives one Mote its own two workfaces and preserves the original input across a real Topic and Folder transition', async () => {
    await app.mount()
    expect(scope().dataset.moteWorkface).toBe(PMO_TEAMS_TOPIC_ID)
    expect(tabs(scope()).map(node => node.dataset.workbenchTabId)).toEqual([defaultTab.id, neighborTab.id])
    const input = scope().querySelector('[aria-label="Message Agent"]')
    expect(input).not.toBeNull()
    expect(input!.textContent).toContain('Default unsent')
    const before = useAppStore.getState()
    expect(before.agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    await act(async () => useAppStore.getState().openScratchTopic(ordinaryTopicId, SCRATCH_WORKSPACE_ID, { tabId: ordinaryTab.id }))
    await settleMoteApp()
    expect(app.container.querySelector('.workspace-workbench-registry [data-mote-workface]')).toBeNull()
    expect(app.container.querySelector('.workspace-workbench-registry .workbench-tab-strip')).not.toBeNull()
    await act(async () => useAppStore.setState({ activeWorkspaceId: 'project' }))
    await settleMoteApp()
    await act(async () => useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { tabId: defaultTab.id }))
    await settleMoteApp()
    expect(scope().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  })

  it('keeps multiple Session Regions inside the same Tab and selects the original exact Region', async () => {
    const split = addWorkbenchRegion(defaultTab, 'default-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'second-original-region', sessionId: neighborAgent.id })
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [defaultTab.id]: split } }))
    await app.mount()
    const regions = [...scope().querySelectorAll<HTMLButtonElement>('[data-mote-session-region]')]
    expect(regions.map(node => node.dataset.moteSessionId)).toEqual([defaultAgent.id, neighborAgent.id])
    expect(tabs(scope()).map(node => node.dataset.workbenchTabId)).toEqual([defaultTab.id, neighborTab.id])
    const original = useAppStore.getState().agentComposerDrafts
    await moteClick(regions[0]!)
    expect(useAppStore.getState().tabs[defaultTab.id]?.layout.activeRegionId).toBe('default-region')
    expect(useAppStore.getState().agentComposerDrafts).toBe(original)
    expect(Object.keys(useAppStore.getState().tabs[defaultTab.id]!.regions)).toEqual(['default-region', 'second-original-region'])
  })

  it('uses the original Tab controls in Float without changing the background layout or view preference', async () => {
    useAppStore.setState({ activeWorkspaceId: 'project', mainSurface: 'board' })
    await app.mount()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
    await settleMoteApp()
    const before = useAppStore.getState()
    expect(tabs(app.panel()).map(node => node.dataset.workbenchTabId)).toEqual([defaultTab.id, neighborTab.id])
    await moteClick(tabs(app.panel())[1]!)
    expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
    const after = useAppStore.getState()
    expect(after.activeWorkspaceId).toBe('project'); expect(after.mainSurface).toBe('board')
    expect(after.layouts).toBe(before.layouts)
    expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(after.viewModes).toBe(before.viewModes)
    expect(app.panel().querySelector('[aria-label="Close Other goal"]')).not.toBeNull()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('[data-mote-topic-id="' + customMoteId + '"]')!)
    expect(tabs(app.panel()).map(node => node.dataset.workbenchTabId)).toEqual([customTab.id])
    expect(app.panel().querySelector('[data-mote-session-id="' + defaultAgent.id + '"]')).toBeNull()
  })
})
