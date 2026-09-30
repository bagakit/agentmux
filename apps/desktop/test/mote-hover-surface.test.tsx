// @vitest-environment happy-dom
import { act, createElement, Fragment, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { pmoTeamsTopicFloatingViewTargets, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { effectiveSessionViewMode } from '../src/renderer/src/lib/session-presentation'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { warmLauncherId } from '../src/renderer/src/lib/warm-terminal-preview'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry'
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WindowOverlayPortal } from '../src/renderer/src/components/WindowOverlayHost'
import { customAgent, customMoteId, customTab, defaultAgent, defaultTab, executionAgent, installNativePopover,
  moteTopics, neighborAgent, ordinaryTab, quietMoteId, quietTab, savedMoteKey, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

// Keep the actual Workbench, SessionPane, Composer and launcher. Only the native
// Terminal attachment and Markdown body are outside this bounded DOM proof.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ sessionId, visible }: { sessionId: string; visible: boolean }) =>
  createElement('div', { 'data-terminal-session': sessionId, 'data-visible': String(visible) }) }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: ({ sessionId }: { sessionId: string }) => createElement('div', { 'data-activity-session': sessionId }) }))
vi.mock('../src/renderer/src/components/SessionMailbox', () => ({ SessionMailbox: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))

const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement, restorePopover: () => void
let warm: ReturnType<typeof vi.fn>, detect: ReturnType<typeof vi.fn>, launch: ReturnType<typeof vi.fn>, send: ReturnType<typeof vi.fn>
function Workface({ focus = false, workbenchVisible = false }: { focus?: boolean; workbenchVisible?: boolean }) {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const tabs = useAppStore(state => state.tabs)
  const layout = useAppStore(state => state.layouts[SCRATCH_WORKSPACE_ID])
  const pmo = useAppStore(state => state.agentFocus.pmo.sessionId)
  const targets = useMemo(() => pmoTeamsTopicFloatingViewTargets(floating, tabs, layout, pmo), [floating, tabs, layout, pmo])
  return createElement(Fragment, null,
    createElement('input', { id: 'original-input', defaultValue: 'Original caret' }),
    createElement(PmoTeamsTopicEntry),
    focus ? createElement(GlobalFocusSurface) : null,
    createElement('div', { 'data-original-workbench': true }, createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID, visible: workbenchVisible, viewTargets: targets })),
    createElement(PmoTeamsTopicFloatingPanel, { floating, setFloating }))
}
function panel() { return container.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')! }
function entry() { return container.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')! }
function choice(id: string) { const result = panel().querySelector<HTMLButtonElement>(`[data-mote-topic-id="${id}"]`); expect(result).not.toBeNull(); return result! }
function saved() { return window.localStorage.getItem(savedMoteKey) }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }
async function mount(focus = false, workbenchVisible = false) { await act(async () => root.render(createElement(Workface, { focus, workbenchVisible }))); await settle() }
async function pointer(element: HTMLElement, type: 'over' | 'out' | 'down') {
  await act(async () => element.dispatchEvent(new PointerEvent('pointer' + type, { bubbles: true, pointerType: 'mouse', buttons: type === 'down' ? 1 : 0 })))
  // happy-dom does not synthesize Chromium's enter/leave boundary events.
  if (type !== 'down') await act(async () => element.dispatchEvent(new PointerEvent(type === 'over' ? 'pointerenter' : 'pointerleave', { pointerType: 'mouse' })))
}
async function hover() { await pointer(entry(), 'over'); await settle() }
async function click(element: HTMLElement) { await pointer(element, 'down'); await act(async () => element.click()); await settle() }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear(); restorePopover = installNativePopover(); seedMoteWorkface()
  warm = vi.fn(); detect = vi.fn(async () => {}); launch = vi.fn(); send = vi.fn(() => true)
  useAppStore.setState({ prewarmTerminal: warm, detectExecutors: detect, launchAgent: launch, send, reportError: vi.fn() })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id)!)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id) ?? null)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); restorePopover(); window.localStorage.clear()
  vi.restoreAllMocks(); useAppStore.setState(baseline, true)
})

describe('one operative Mote hover surface', () => {
  it.each(['missing', 'other-topic', 'other-workspace', 'unplaced'] as const)('retains the exact saved Tab when it is %s without activating a neighboring launcher', async availability => {
    const neighbor = { ...createWorkbenchTab('neighbor-launcher', { regionId: 'neighbor-launcher-region',
      kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
    const { [defaultTab.id]: _default, 'neighbor-tab': _neighbor, ...otherTabs } = useAppStore.getState().tabs
    const retained = availability === 'missing' ? {} : { [defaultTab.id]: availability === 'other-topic'
      ? { ...ordinaryTab, id: defaultTab.id } : availability === 'other-workspace'
        ? { ...defaultTab, workspaceId: 'project' } : defaultTab }
    const tabs = { ...otherTabs, ...retained, [neighbor.id]: neighbor }
    const placed = [neighbor.id, ...Object.keys(tabs).filter(id => id !== neighbor.id && (availability !== 'unplaced' || id !== defaultTab.id))]
    useAppStore.setState({ tabs, layouts: { ...useAppStore.getState().layouts,
      [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', placed) },
      agentComposerDrafts: { ...useAppStore.getState().agentComposerDrafts, [neighbor.layout.activeRegionId]: 'Neighbor unsent' } })
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
    // One case leaves a healthy neighboring launcher visible in the original
    // workface. It keeps its already-authorized activation through this peek.
    const backgroundVisible = availability === 'missing'
    if (backgroundVisible) useAppStore.setState({ activeWorkspaceId: SCRATCH_WORKSPACE_ID, mainSurface: 'workbench' })
    await mount(false, backgroundVisible)
    const original = useAppStore.getState(), calls = warm.mock.calls.length
    const input = container.querySelector<HTMLElement>(`[data-original-workbench] [data-workbench-tab-id="${neighbor.id}"] [aria-label="Agent prompt"]`)!
    expect(input).not.toBeNull()
    if (backgroundVisible) expect(calls).toBeGreaterThan(0)
    else expect(calls).toBe(0)
    await hover(); await click(entry())
    expect(panel().dataset.moteTargetTab).toBe(defaultTab.id)
    expect(panel().dataset.moteTargetTopic).toBe(PMO_TEAMS_TOPIC_ID)
    if (availability !== 'unplaced') {
      expect(entry().dataset.moteStatus).toBe('Restoring context')
      expect(choice(PMO_TEAMS_TOPIC_ID).dataset.moteStatus).toBe('Restoring context')
      expect(panel().dataset.moteTargetSession).toBeUndefined()
    }
    expect(panel().textContent).toContain('Original Tab retained')
    expect(panel().querySelector('[aria-label="Agent prompt"]')).toBeNull()
    expect(container.querySelector(`[data-original-workbench] [data-workbench-tab-id="${neighbor.id}"] [aria-label="Agent prompt"]`)).toBe(input)
    expect(input.textContent).toBe('Neighbor unsent')
    expect(warm.mock.calls).toHaveLength(calls)
    expect(pmoTeamsTopicFloatingViewTargets({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id },
      original.tabs, original.layouts[SCRATCH_WORKSPACE_ID], original.agentFocus.pmo.sessionId)).toBeUndefined()
    expect(useAppStore.getState().layouts).toBe(original.layouts)
    expect(useAppStore.getState().tabs).toBe(original.tabs)
    expect(useAppStore.getState().sessions).toBe(original.sessions)
    expect(useAppStore.getState().agentFocus.execution).toEqual(original.agentFocus.execution)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect(useAppStore.getState().viewModes).toBe(original.viewModes)
    expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })

  it('keeps an empty Mote through deferred identity failure and retry until explicit New Tab', async () => {
    const { [quietTab.id]: _tab, ...tabs } = useAppStore.getState().tabs
    useAppStore.setState({ tabs, layouts: { ...useAppStore.getState().layouts,
      [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(tabs)) } })
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: quietMoteId }))
    let failEnsure!: (error: Error) => void
    vi.mocked(api.scratch.ensureMote).mockReturnValueOnce(new Promise((_resolve, reject) => { failEnsure = reject }))
    await mount()
    const before = useAppStore.getState()
    await hover()
    expect(panel().dataset.moteTargetTopic).toBe(quietMoteId)
    expect(panel().dataset.moteTargetTab).toBeUndefined()
    expect(panel().querySelector('[data-workbench-pending-owner]')).not.toBeNull()
    expect(panel().querySelector('[aria-label="Agent prompt"]')).toBeNull()
    expect(warm).not.toHaveBeenCalled(); expect(api.scratch.ensureMote).not.toHaveBeenCalled()
    await click(entry())
    expect(api.scratch.ensureMote).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, quietMoteId)
    expect(panel().querySelector('[aria-label="Agent prompt"]')).toBeNull()
    expect(warm).not.toHaveBeenCalled()
    await act(async () => failEnsure(new Error('identity unavailable')))
    await settle()
    expect(panel().textContent).toContain('Context preparation did not complete')
    expect(panel().querySelector('[aria-label="Agent prompt"]')).toBeNull()
    expect(warm).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeWorkspaceId).toBe(before.activeWorkspaceId)
    expect(useAppStore.getState().mainSurface).toBe(before.mainSurface)
    expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    const retry = Array.from(panel().querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Retry context')!
    await click(retry)
    expect(panel().dataset.moteTargetTab).toBeUndefined()
    expect(panel().querySelector('[aria-label="Agent prompt"]')).toBeNull()
    expect(warm).not.toHaveBeenCalled()
    expect(api.scratch.readTopic).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    const newTab = panel().querySelector<HTMLButtonElement>('[aria-label="New Tab"]')!
    expect(newTab).not.toBeNull(); await click(newTab)
    const tabId = panel().dataset.moteTargetTab!, tab = useAppStore.getState().tabs[tabId]!
    expect(tab?.topicId).toBe(quietMoteId)
    expect(tab?.workspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(tab?.regions[tab.layout.activeRegionId]?.kind).toBe('launcher')
    expect(panel().querySelector('[aria-label="Agent prompt"]')).not.toBeNull()
    expect(warm).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, warmLauncherId({ tabGroupId: 'mote-group', regionId: tab.layout.activeRegionId }))
    expect(new Set(warm.mock.calls.map(call => call[0]))).toEqual(new Set([SCRATCH_WORKSPACE_ID]))
    expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })

  it.each(['project', 'other-topic', 'same-topic'] as const)('creates a projected New tab in its exact Mote while %s stays behind it', async background => {
    if (background !== 'project') {
      useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', background === 'other-topic' ? ordinaryTab.id : customTab.id)
      useAppStore.setState({ activeWorkspaceId: SCRATCH_WORKSPACE_ID, mainSurface: 'workbench' })
    }
    await mount(); await hover(); await click(choice(customMoteId))
    const before = useAppStore.getState(), group = before.layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!
    const previousIds = Object.keys(before.tabs)
    const plus = panel().querySelector<HTMLButtonElement>('[title="New tab"]')!
    expect(plus).not.toBeNull()
    await click(plus)
    const state = useAppStore.getState(), createdIds = Object.keys(state.tabs).filter(id => !previousIds.includes(id))
    expect(createdIds).toHaveLength(1)
    const newId = createdIds[0]!, tab = state.tabs[newId]!
    expect(tab.topicId).toBe(customMoteId)
    expect(tab.workspaceId).toBe(SCRATCH_WORKSPACE_ID)
    expect(tab.regions[tab.layout.activeRegionId]?.kind).toBe('launcher')
    expect(panel().dataset.moteTargetTab).toBe(newId)
    expect(panel().dataset.moteTargetTopic).toBe(customMoteId)
    expect(state.mainSurface).toBe(before.mainSurface)
    expect(state.activeWorkspaceId).toBe(before.activeWorkspaceId)
    expect(state.layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBe(group.activeTabId)
    expect(state.layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.recentTabIds).toEqual(group.recentTabIds)
    expect(state.agentFocus.execution).toEqual(before.agentFocus.execution)
    expect(state.sessions).toBe(before.sessions)
    const input = panel().querySelector<HTMLElement>('[aria-label="Agent prompt"]')!
    expect(input).not.toBeNull()
    expect(input.closest('[data-workbench-tab-id]')?.getAttribute('data-workbench-tab-id')).toBe(newId)
    await act(async () => {
      input.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'New Mote unsent' }))
      input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'New Mote unsent', bubbles: true }))
    }); await settle()
    expect(useAppStore.getState().agentComposerDrafts[tab.layout.activeRegionId]).toBe('New Mote unsent')
    expect(useAppStore.getState().agentComposerDrafts[customAgent.id]).toBe('Analyst unsent')
    // A second header action must retain its own new Tab instead of letting a
    // late DOM listener borrow the original durable active Tab behind it.
    await click(panel().querySelector<HTMLButtonElement>('[title="New tab"]')!)
    const next = useAppStore.getState(), secondIds = Object.keys(next.tabs).filter(id => !Object.keys(state.tabs).includes(id))
    expect(secondIds).toHaveLength(1)
    const secondId = secondIds[0]!
    expect(panel().dataset.moteTargetTab).toBe(secondId)
    expect(next.tabs[secondId]?.topicId).toBe(customMoteId)
    expect(next.activeWorkspaceId).toBe(before.activeWorkspaceId)
    expect(next.mainSurface).toBe(before.mainSurface)
    expect(next.layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBe(group.activeTabId)
    expect(next.agentComposerDrafts[tab.layout.activeRegionId]).toBe('New Mote unsent')
    await click(panel().querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${newId}"]`)!)
    expect(panel().dataset.moteTargetTab).toBe(newId)
    expect(panel().querySelector('[aria-label="Agent prompt"]')).toBe(input)
    await click(entry()); await click(entry())
    expect(panel().dataset.moteTargetTab).toBe(newId)
    expect(panel().querySelector('[aria-label="Agent prompt"]')).toBe(input)
    expect(input.textContent).toBe('New Mote unsent')
    expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })

  it('shows immediately without moving caret, persisting intent, changing mode or running actions', async () => {
    await mount()
    const input = container.querySelector<HTMLInputElement>('#original-input')!
    input.focus(); input.setSelectionRange(3, 6)
    const state = useAppStore.getState(), storage = saved()
    await hover()
    expect(panel().dataset.motePresentation).toBe('preview')
    expect(panel().matches(':popover-open')).toBe(true)
    expect(entry().getAttribute('popovertarget')).toBe(panel().id)
    expect(entry().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6])
    expect(saved()).toBe(storage)
    expect(useAppStore.getState().viewModes).toBe(state.viewModes)
    expect(useAppStore.getState().agentFocus).toBe(state.agentFocus)
    expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
    expect(useAppStore.getState().agentSteerQueues).toBe(state.agentSteerQueues)
    expect(api.scratch.ensureMote).not.toHaveBeenCalled(); expect(api.scratch.readTopic).not.toHaveBeenCalled()
    expect(warm).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
    expect(panel().querySelectorAll('.agent-surface')).toHaveLength(1)
    expect(panel().querySelector('[data-activity-session]')?.getAttribute('data-activity-session')).toBe(defaultAgent.id)
    expect(panel().querySelector('[aria-label="Show Terminal"]')).not.toBeNull()
    await pointer(entry(), 'out'); await pointer(panel(), 'over')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)) })
    expect(panel().dataset.motePresentation).toBe('preview')
    await pointer(panel(), 'out')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)) })
    expect(panel().dataset.motePresentation).toBe('closed')
    expect(document.activeElement).toBe(input)
    expect(saved()).toBe(storage)
    expect(useAppStore.getState().tabs).toBe(state.tabs)
  })

  it('keeps the actual launcher passive on hover and activates its original owner only on pin', async () => {
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: quietMoteId, targetTabId: quietTab.id }))
    await mount()
    const input = container.querySelector<HTMLInputElement>('#original-input')!; input.focus()
    const drafts = useAppStore.getState().agentComposerDrafts, modes = useAppStore.getState().viewModes, disk = saved()
    await hover()
    expect(panel().dataset.moteTargetTopic).toBe(quietMoteId)
    expect(panel().dataset.moteStatus).toBe('No Agent yet')
    const launcher = panel().querySelector<HTMLElement>('[aria-label="Initial prompt"]') ?? panel().querySelector<HTMLElement>('[contenteditable="true"]')
    expect(launcher).not.toBeNull()
    expect(launcher!.textContent).toBe('Launcher unsent')
    expect(document.activeElement).toBe(input)
    expect(warm).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
    expect(saved()).toBe(disk)
    await click(entry())
    expect(panel().dataset.motePresentation).toBe('pinned')
    expect(warm).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, expect.any(String))
    expect(detect).toHaveBeenCalled()
    expect(useAppStore.getState().viewModes).toBe(modes)
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    await pointer(panel(), 'out'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)) })
    expect(panel().dataset.motePresentation).toBe('pinned')
    expect(JSON.parse(saved()!)).toEqual({ open: true, targetTopicId: quietMoteId, targetTabId: quietTab.id })
    expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })

  it('keeps the bridge and pins actual retained portal input pointer and focus interactions', async () => {
    await mount()
    const original = container.querySelector<HTMLInputElement>('#original-input')!; original.focus()
    await hover(); await pointer(entry(), 'out')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const input = panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull()
    expect(input.closest('.retained-workbench-view')).not.toBeNull()
    // Chromium fires enter at the physical panel even when the View's React
    // ancestors are in the original Workbench, outside this panel component.
    await act(async () => panel().dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })))
    await act(async () => input.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true })))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)) })
    expect(panel().dataset.motePresentation).toBe('preview')
    expect(saved()).toBeNull()
    expect(document.activeElement).toBe(original)
    await pointer(input, 'down')
    expect(panel().dataset.motePresentation).toBe('pinned')
    expect(JSON.parse(saved()!).open).toBe(true)
    await pointer(panel(), 'out'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)) })
    expect(panel().dataset.motePresentation).toBe('pinned')
    await click(entry()); original.focus(); await hover()
    await act(async () => input.focus())
    expect(panel().dataset.motePresentation).toBe('pinned')
    expect(document.activeElement).toBe(input)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
    expect(panel().dataset.motePresentation).toBe('closed')
    expect(document.activeElement).toBe(original)
    expect(send).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
  })

  it('selects every filesystem Mote once and moves the original custom workface with its draft and status', async () => {
    await mount(); await hover()
    expect(Array.from(panel().querySelectorAll<HTMLElement>('[data-mote-topic-id]'), row => row.dataset.moteTopicId)).toEqual([PMO_TEAMS_TOPIC_ID, customMoteId, quietMoteId])
    expect(choice(PMO_TEAMS_TOPIC_ID).dataset.moteStatus).toBe('Working')
    expect(choice(customMoteId).dataset.moteStatus).toBe('Needs reply')
    expect(choice(quietMoteId).dataset.moteStatus).toBe('No Agent yet')
    expect(choice(PMO_TEAMS_TOPIC_ID).querySelector('img')?.getAttribute('src')).toBe(entry().querySelector('img')?.getAttribute('src'))
    expect(choice(customMoteId).querySelector('[data-space-icon-source="automatic"] svg')).not.toBeNull()
    const key = topicSpaceIconTarget(scratchWorkspace, moteTopics[1]!).key
    await act(async () => useAppStore.setState({ spaceObjectIcons: { [key]: 'brain' } }))
    expect(choice(customMoteId).querySelector('[data-space-icon-source="manual"]')?.getAttribute('data-space-icon')).toBe('brain')
    const execution = useAppStore.getState().agentFocus.execution, drafts = useAppStore.getState().agentComposerDrafts
    const original = container.querySelector(`[data-workbench-tab-id="${customTab.id}"] [data-agent-surface-mode="activity"]`)
    expect(original).not.toBeNull()
    await click(choice(customMoteId))
    expect(panel().dataset.moteTargetTopic).toBe(customMoteId)
    expect(panel().dataset.moteTargetTab).toBe(customTab.id)
    expect(panel().dataset.moteTargetRegion).toBe('custom-region')
    expect(panel().dataset.moteTargetSession).toBe(customAgent.id)
    expect(panel().dataset.moteStatus).toBe(entry().dataset.moteStatus)
    expect(panel().querySelector('[data-agent-surface-mode="activity"]')).toBe(original)
    expect(panel().querySelector(`[data-activity-session="${customAgent.id}"]`)).not.toBeNull()
    expect(panel().querySelectorAll('[data-activity-session]')).toHaveLength(1)
    expect(panel().querySelector('[aria-label="Message Agent"]')?.textContent).toBe('Analyst unsent')
    expect(useAppStore.getState().agentFocus.execution).toEqual(execution)
    expect(useAppStore.getState().agentComposerDrafts).toEqual(drafts)
    expect(api.scratch.ensureMote).toHaveBeenLastCalledWith(SCRATCH_WORKSPACE_ID, customMoteId)
    expect(api.scratch.readTopic).toHaveBeenLastCalledWith(SCRATCH_WORKSPACE_ID, customMoteId)
    expect(panel().querySelector('.top-row-leading-chrome')).toBeNull()
    expect(panel().querySelector('.pmo-teams-topic-floating__title')).toBeNull()
    expect(entry().title).toBe('')
    await click(panel().querySelector<HTMLButtonElement>('[aria-label="Send"]')!)
    expect(send).toHaveBeenCalledExactlyOnceWith(customAgent.id, 'Analyst unsent', expect.any(Function), 'manual')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    await click(entry()); await click(entry())
    expect(panel().dataset.moteTargetTab).toBe(customTab.id)
    expect(useAppStore.getState().agentFocus.execution).toEqual(execution)
  })

  it('preserves readonly Activity through peek and pin and honors explicit Terminal in both actual consumers', async () => {
    await mount(); await hover()
    const modes = useAppStore.getState().viewModes
    expect(panel().querySelector('[data-agent-surface-mode="activity"]')).not.toBeNull()
    expect(panel().querySelector('[aria-label="Show Terminal"]')).not.toBeNull()
    await click(entry())
    expect(useAppStore.getState().viewModes).toBe(modes)
    expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState()).viewModes).toEqual({})
    expect(effectiveSessionViewMode(useAppStore.getState(), defaultAgent.id)).toBe('activity')
    await click(panel().querySelector<HTMLButtonElement>('[aria-label="Show Terminal"]')!)
    expect(useAppStore.getState().viewModes[defaultAgent.id]).toBe('terminal')
    expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState()).viewModes).toEqual({ [defaultAgent.id]: 'terminal' })
    expect(panel().querySelector('[data-agent-surface-mode="terminal"]')).not.toBeNull()
    expect(panel().querySelector('[aria-label="Show Activity"]')).not.toBeNull()
    await click(entry()); await hover()
    expect(panel().querySelector('[data-agent-surface-mode="terminal"]')).not.toBeNull()
    expect(panel().querySelector('[aria-label="Show Activity"]')).not.toBeNull()
    await click(entry())
    expect(panel().querySelector('[data-agent-surface-mode="activity"]')).not.toBeNull()
    expect(useAppStore.getState().viewModes[defaultAgent.id]).toBe('activity')
  })

  it('opens explicitly from keyboard focus and returns to the same entry without reopening a preview', async () => {
    await mount()
    await act(async () => entry().focus())
    expect(panel().dataset.motePresentation).toBe('closed')
    await act(async () => entry().click()); await settle()
    expect(panel().dataset.motePresentation).toBe('pinned')
    expect(document.activeElement).toBe(panel())
    await act(async () => panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
    expect(panel().dataset.motePresentation).toBe('closed')
    expect(document.activeElement).toBe(entry())
    expect(JSON.parse(saved()!).open).toBe(false)
  })

  it.each(['bound', 'missing', 'unknown'] as const)('uses the actual Focus attention Topic when its Tab is $case', async state => {
    const { [customTab.id]: _tab, ...withoutCustom } = useAppStore.getState().tabs
    useAppStore.setState({ sessions: useAppStore.getState().sessions.filter(session => session.id !== neighborAgent.id),
      ...(state !== 'bound' ? { tabs: withoutCustom } : {}), mainSurface: 'agents' })
    await mount(true)
    const attention = container.querySelector<HTMLButtonElement>('.focus-pmo-attention')!
    expect(attention?.textContent).toContain(moteTopics.find(topic => topic.id === customMoteId)!.title)
    expect(attention?.textContent).toContain('1 to review')
    const original = useAppStore.getState().agentFocus.execution
    await act(async () => {
      if (state === 'unknown') useAppStore.setState({ sessions: useAppStore.getState().sessions.filter(session => session.id !== customAgent.id) })
      attention.click()
    }); await settle()
    if (state === 'unknown') {
      expect(panel().dataset.motePresentation).toBe('closed')
      expect(saved()).toBeNull()
      expect(api.scratch.ensureMote).not.toHaveBeenCalled()
      expect(useAppStore.getState().reportError).toHaveBeenCalledOnce()
    } else {
      expect(panel().dataset.motePresentation).toBe('pinned')
      expect(panel().dataset.moteTargetTopic).toBe(customMoteId)
      expect(api.scratch.ensureMote).toHaveBeenLastCalledWith(SCRATCH_WORKSPACE_ID, customMoteId)
      if (state === 'bound') expect(panel().dataset.moteTargetTab).toBe(customTab.id)
      else {
        expect(panel().dataset.moteTargetTab).toBeUndefined()
        expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === customMoteId)).toEqual([])
        expect(panel().querySelector('[aria-label="New Tab"]')).not.toBeNull()
        expect(panel().dataset.moteTargetSession).toBeUndefined()
      }
    }
    expect(useAppStore.getState().agentFocus.execution).toEqual(original)
    expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })

  it('ignores IME Escape, dismisses preview without focus return and restores only the pinned target on remount', async () => {
    await mount()
    const input = container.querySelector<HTMLInputElement>('#original-input')!; input.focus()
    await hover()
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })))
    expect(panel().dataset.motePresentation).toBe('preview')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(panel().dataset.motePresentation).toBe('closed')
    expect(document.activeElement).toBe(input)
    expect(saved()).toBeNull()
    await hover(); await click(choice(customMoteId))
    const draft = useAppStore.getState().agentComposerDrafts, execution = useAppStore.getState().agentFocus.execution
    await act(async () => root.unmount()); root = createRoot(container)
    await mount()
    expect(panel().dataset.motePresentation).toBe('pinned')
    expect(panel().dataset.moteTargetTopic).toBe(customMoteId)
    expect(panel().dataset.moteTargetTab).toBe(customTab.id)
    expect(panel().querySelector('[aria-label="Message Agent"]')?.textContent).toBe('Analyst unsent')
    expect(useAppStore.getState().agentComposerDrafts).toEqual(draft)
    expect(useAppStore.getState().agentFocus.execution).toEqual(execution)
    expect(send).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
    await click(entry()); await hover()
    await act(async () => root.unmount()); root = createRoot(container)
    await mount()
    expect(panel().dataset.motePresentation).toBe('closed')
    expect(panel().dataset.moteTargetTab).toBe(customTab.id)
  })

  it.each(['portal', 'popover'] as const)('lets another mounted %s own Escape while the actual Mote remains a passive preview', async kind => {
    const handled = vi.fn()
    const foreign = createElement('div', { id: 'foreign-float', role: 'dialog', 'data-state': 'open',
      ...(kind === 'popover' ? { popover: 'manual' as const } : {}),
      onKeyDown(event: import('react').KeyboardEvent<HTMLDivElement>) {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.preventDefault(); event.stopPropagation(); handled()
        event.currentTarget.dataset.state = 'closed'
        if (kind === 'popover') event.currentTarget.hidePopover()
      }
    }, createElement('input', { id: 'foreign-stage', 'data-native-browser-stage': 'foreign-browser', defaultValue: 'Other unsent text' }))
    await act(async () => root.render(createElement(Fragment, null, createElement(Workface),
      kind === 'portal' ? createElement(WindowOverlayPortal, { layer: 'dialog', children: foreign }) : foreign)))
    await settle()
    const owner = document.getElementById('foreign-float')!, stage = document.getElementById('foreign-stage') as HTMLInputElement
    if (kind === 'popover') await act(async () => owner.showPopover())
    stage.focus(); stage.setSelectionRange(5, 5)
    await hover()
    const original = useAppStore.getState()
    await act(async () => stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })))
    expect(panel().dataset.motePresentation).toBe('preview')
    expect(handled).not.toHaveBeenCalled()
    await act(async () => stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(handled).toHaveBeenCalledOnce()
    expect(owner.dataset.state).toBe('closed')
    expect(panel().dataset.motePresentation).toBe('preview')
    expect(document.activeElement).toBe(stage)
    expect(stage.value).toBe('Other unsent text'); expect(stage.selectionStart).toBe(5)
    expect(useAppStore.getState().tabs).toBe(original.tabs)
    expect(useAppStore.getState().layouts).toBe(original.layouts)
    expect(useAppStore.getState().viewModes).toBe(original.viewModes)
    expect(useAppStore.getState().agentFocus.execution).toEqual(original.agentFocus.execution)
    expect(saved()).toBeNull()
    expect(api.scratch.ensureMote).not.toHaveBeenCalled()
    expect(warm).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
    const background = container.querySelector<HTMLInputElement>('#original-input')!
    background.focus()
    await act(async () => background.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(panel().dataset.motePresentation).toBe('closed')
    expect(document.activeElement).toBe(background)
  })

  it('does not reread files or rescan all Tabs for 35 unrelated output events while all Motes are visible', async () => {
    seedMoteWorkface({ directory: false })
    const tabs = useAppStore.getState().tabs, values = Object.values
    let scans = 0
    vi.spyOn(Object, 'values').mockImplementation((value: object) => {
      // Count actual scans by the navigation resolver, including non-rendering
      // Zustand selector calls. The independent persistence owner also scans
      // these Tabs and is not changed or claimed by this feature.
      if (value === tabs && new Error().stack?.includes('pmoTeamsTopicFloatingTargetTabId')) scans++
      return values(value)
    })
    await mount(); await hover()
    const before = scans, list = vi.mocked(api.scratch.listTopics)
    expect(before).toBeGreaterThan(0)
    expect(list).toHaveBeenCalledOnce()
    expect(panel().querySelectorAll('[data-mote-topic-id]')).toHaveLength(3)
    const original = panel().querySelector('[data-activity-session]')
    for (let revision = 1; revision <= 35; revision++) await act(async () => useAppStore.setState({
      sessions: useAppStore.getState().sessions.map(session => session.id === executionAgent.id ? { ...session, latestOutputBytes: revision * 4096 } : session),
      timelines: { [executionAgent.id]: { agentSessionId: executionAgent.id, revision, items: [] } },
      agentNames: { [executionAgent.id]: 'Unrelated ' + revision }
    }))
    expect(scans).toBe(before)
    expect(list).toHaveBeenCalledOnce()
    expect(panel().querySelector('[data-activity-session]')).toBe(original)
    expect(panel().dataset.moteTargetTab).toBe(defaultTab.id)
    await act(async () => useAppStore.setState({ sessions: useAppStore.getState().sessions.map(session => session.id === defaultAgent.id ? { ...neighborAgent, id: defaultAgent.id, control: defaultAgent.control } : session) }))
    expect(entry().dataset.moteStatus).toBe('Needs reply')
    expect(choice(PMO_TEAMS_TOPIC_ID).dataset.moteStatus).toBe('Needs reply')
    expect(scans).toBe(before)
  })
})
