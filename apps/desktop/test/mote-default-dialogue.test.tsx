// @vitest-environment happy-dom
import { act, createElement, Fragment, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { pinPmoTeamsTopicFloating, pmoTeamsTopicFloatingViewTargets, requestPmoTeamsTopicFloatingOpen,
  usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { effectiveSessionViewMode } from '../src/renderer/src/lib/session-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry'
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { customAgent, customMoteId, customTab, defaultAgent, defaultTab, executionAgent, installNativePopover,
  moteTopics, neighborAgent, ordinaryTab, quietTab, savedMoteKey, seedMoteWorkface } from './fixtures/mote-workface'

// Native transport and timeline rendering are controlled; the real Entry,
// retained Workbench, SessionPane, Composer, target and mode owners remain.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ sessionId }: { sessionId: string }) =>
  createElement('div', { 'data-terminal-session': sessionId }) }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: ({ sessionId }: { sessionId: string }) =>
  createElement('div', { 'data-activity-session': sessionId }) }))
vi.mock('../src/renderer/src/components/SessionMailbox', () => ({ SessionMailbox: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))

const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement, restorePopover: () => void
let launch: ReturnType<typeof vi.fn>, send: ReturnType<typeof vi.fn>
function Workface({ probeOnly = false }: { probeOnly?: boolean }) {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const tabs = useAppStore(state => state.tabs), layout = useAppStore(state => state.layouts[SCRATCH_WORKSPACE_ID])
  const pmo = useAppStore(state => state.agentFocus.pmo.sessionId)
  const targets = useMemo(() => pmoTeamsTopicFloatingViewTargets(floating, tabs, layout, pmo), [floating, tabs, layout, pmo])
  if (probeOnly) return createElement('output', { 'data-floating-open': String(floating.open), 'data-floating-tab': floating.targetTabId })
  return createElement(Fragment, null,
    createElement('input', { id: 'original-input', defaultValue: 'Original caret' }),
    createElement(PmoTeamsTopicEntry), createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID, visible: false, viewTargets: targets }),
    createElement(PmoTeamsTopicFloatingPanel, { floating, setFloating }))
}
function panel() { const node = container.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]'); expect(node).not.toBeNull(); return node! }
function entry() { const node = container.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button'); expect(node).not.toBeNull(); return node! }
function button(label: string) { const node = panel().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(node, label).not.toBeNull(); return node! }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
async function mount(probeOnly = false) { await act(async () => root.render(createElement(Workface, { probeOnly }))); await settle() }
async function click(node: HTMLElement) { await act(async () => node.click()); await settle() }
async function hover() {
  await act(async () => entry().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await act(async () => entry().dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse', buttons: 0 }))); await settle()
}
function originalFacts() {
  const state = useAppStore.getState()
  return { tabs: state.tabs, layouts: state.layouts, sessions: state.sessions, focus: state.agentFocus.execution,
    activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface,
    drafts: state.agentComposerDrafts, queues: state.agentSteerQueues, timelines: state.timelines }
}
function expectWorkRetained(before: ReturnType<typeof originalFacts>) {
  expect(originalFacts()).toEqual(before)
  expect(Object.keys(before.tabs)).toHaveLength(5)
  expect(Object.keys(before.drafts)).toHaveLength(4)
  expect(before.sessions).toHaveLength(5)
  expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear(); restorePopover = installNativePopover(); seedMoteWorkface()
  launch = vi.fn(); send = vi.fn(() => true)
  useAppStore.setState({ viewModes: Object.fromEntries(useAppStore.getState().sessions.map(one => [one.id, 'terminal' as const])),
    launchAgent: launch, send, prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}), reportError: vi.fn() })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async (_workspace, id) => moteTopics.find(one => one.id === id)!)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => moteTopics.find(one => one.id === id) ?? null)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); restorePopover(); window.localStorage.clear()
  vi.restoreAllMocks(); useAppStore.setState(baseline, true)
})

describe('Mote explicit reopen dialogue at the original owner', () => {
  it.each([{ topic: PMO_TEAMS_TOPIC_ID, tab: defaultTab, session: defaultAgent },
    { topic: customMoteId, tab: customTab, session: customAgent }])('reopens $topic through its real entry after Terminal and readonly hover', async ({ topic, tab, session }) => {
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: topic, targetTabId: tab.id }))
    await mount()
    const before = originalFacts(), otherModes = { ...useAppStore.getState().viewModes }
    const originalSetMode = useAppStore.getState().setViewMode
    const setMode = vi.spyOn(useAppStore.getState(), 'setViewMode').mockImplementation((...args) => {
      const focus = useAppStore.getState().agentFocus
      originalSetMode(...args)
      if (args[2]?.focus === false) expect(useAppStore.getState().agentFocus).toBe(focus)
    })
    await click(entry())
    expect(setMode).toHaveBeenCalledExactlyOnceWith(session.id, 'activity', { focus: false })
    expect(panel().querySelector(`[data-activity-session="${session.id}"]`), panel().textContent ?? '').not.toBeNull()
    expect(panel().querySelector('[data-agent-surface-mode="activity"]')).not.toBeNull()
    expect(panel().dataset.moteTargetTab).toBe(tab.id)
    expect(panel().dataset.moteTargetSession).toBe(session.id)
    expect(button('Message Agent').textContent).toBe(before.drafts[session.id])
    expectWorkRetained(before)
    await click(button('Show Terminal'))
    expect(panel().querySelector('[data-agent-surface-mode="terminal"]')).not.toBeNull()
    expect(effectiveSessionViewMode(useAppStore.getState(), session.id)).toBe('terminal')
    await click(button('Close Mote'))
    const disk = localStorage.getItem(savedMoteKey), modes = useAppStore.getState().viewModes
    const original = container.querySelector<HTMLInputElement>('#original-input')!
    original.focus(); original.setSelectionRange(2, 5)
    await hover()
    expect(panel().dataset.motePresentation).toBe('preview')
    expect(panel().querySelector('[data-agent-surface-mode="terminal"]')).not.toBeNull()
    expect(useAppStore.getState().viewModes).toBe(modes)
    expect(localStorage.getItem(savedMoteKey)).toBe(disk)
    expect(document.activeElement).toBe(original); expect([original.selectionStart, original.selectionEnd]).toEqual([2, 5])
    await click(entry())
    expect(panel().dataset.motePresentation).toBe('pinned')
    expect(panel().querySelector('[data-agent-surface-mode="activity"]')).not.toBeNull()
    expect(useAppStore.getState().viewModes).toEqual({ ...otherModes, [session.id]: 'activity' })
    expect(button('Message Agent').textContent).toBe(before.drafts[session.id])
    expectWorkRetained(before)
    await click(button('Show Terminal'))
    expect(panel().querySelector('[data-agent-surface-mode="terminal"]')).not.toBeNull()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: topic, targetTabId: tab.id }))
    expect(effectiveSessionViewMode(useAppStore.getState(), session.id)).toBe('terminal')
  })

  it('opens a new exact target in dialogue while a repeated open preserves its later Terminal', async () => {
    await mount(); await click(entry()); await click(button('Show Terminal'))
    const before = originalFacts()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: customMoteId, targetTabId: customTab.id })); await settle()
    expect(panel().dataset.moteTargetSession).toBe(customAgent.id)
    expect(effectiveSessionViewMode(useAppStore.getState(), customAgent.id)).toBe('activity')
    expect(effectiveSessionViewMode(useAppStore.getState(), defaultAgent.id)).toBe('terminal')
    await click(button('Show Terminal'))
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: customMoteId, targetTabId: customTab.id })); await settle()
    expect(effectiveSessionViewMode(useAppStore.getState(), customAgent.id)).toBe('terminal')
    expect(panel().querySelector('[data-agent-surface-mode="terminal"]')).not.toBeNull()
    expectWorkRetained(before)
  })

  it.each(['pointer', 'focus'] as const)('naturally pins the visible Terminal by %s without an explicit reopen', async intent => {
    await mount(); const before = originalFacts(), modes = useAppStore.getState().viewModes
    await hover(); expect(panel().querySelector('[data-agent-surface-mode="terminal"]')).not.toBeNull()
    const prompt = button('Message Agent')
    await act(async () => intent === 'pointer' ? prompt.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', buttons: 1 })) : prompt.focus())
    expect(panel().dataset.motePresentation).toBe('pinned')
    expect(useAppStore.getState().viewModes).toBe(modes)
    expectWorkRetained(before)
  })

  it('mounts a durable already-open Terminal without treating load or pin as a human reopen', async () => {
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: customMoteId, targetTabId: customTab.id }))
    const before = originalFacts(), modes = useAppStore.getState().viewModes
    await mount(); expect(panel().querySelector('[data-agent-surface-mode="terminal"]')).not.toBeNull()
    await act(async () => pinPmoTeamsTopicFloating())
    expect(useAppStore.getState().viewModes).toBe(modes)
    expectWorkRetained(before)
  })

  it.each(['missing-tab', 'other-topic', 'other-workspace', 'unplaced', 'missing-region', 'launcher', 'terminal-region', 'terminal-session', 'missing-session',
    'unknown-mote', 'foreign-snapshot', 'ordinary-topic', 'empty'] as const)('keeps %s original references without borrowing a neighboring Agent mode', async availability => {
    let targetTopicId = customMoteId, targetTabId: string | null = customTab.id
    const current = useAppStore.getState(), tabs = { ...current.tabs }
    if (availability === 'missing-tab') delete tabs[customTab.id]
    if (availability === 'other-topic') tabs[customTab.id] = { ...customTab, topicId: PMO_TEAMS_TOPIC_ID }
    if (availability === 'other-workspace') tabs[customTab.id] = { ...customTab, workspaceId: 'project' }
    if (availability === 'missing-region') tabs[customTab.id] = { ...customTab, layout: { ...customTab.layout, activeRegionId: 'missing-original-region' } }
    if (availability === 'terminal-region') tabs[customTab.id] = { ...customTab, regions: { 'custom-region': {
      kind: 'terminal', phase: 'attached', regionId: 'custom-region', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: customAgent.id } } }
    if (availability === 'launcher') { targetTabId = quietTab.id; targetTopicId = quietTab.topicId! }
    if (availability === 'ordinary-topic') { targetTabId = ordinaryTab.id; targetTopicId = ordinaryTab.topicId! }
    if (availability === 'empty') targetTabId = null
    useAppStore.setState({ tabs,
      ...(availability === 'missing-session' ? { sessions: current.sessions.filter(one => one.id !== customAgent.id) } : {}),
      ...(availability === 'terminal-session' ? { sessions: current.sessions.map(one => one.id !== customAgent.id ? one : {
        id: customAgent.id, kind: 'terminal' as const, providerId: null, hostId: 'local', workspacePath: customAgent.workspacePath,
        label: 'Retained terminal', createdAt: 1, updatedAt: 2, processState: 'running' as const, latestOutputBytes: 0,
        status: { state: 'running' as const, source: 'run-process' as const, observedAt: 2 },
        control: { kind: 'terminal' as const, hostId: 'local', runId: 'original-terminal', run: { runId: 'original-terminal' } } }) } : {}),
      ...(availability === 'unplaced' ? { layouts: { ...current.layouts, [SCRATCH_WORKSPACE_ID]: {
        ...current.layouts[SCRATCH_WORKSPACE_ID]!, groups: current.layouts[SCRATCH_WORKSPACE_ID]!.groups.map(group => ({ ...group,
          tabOrder: group.tabOrder.filter(id => id !== customTab.id) })) } } } : {}),
      ...(['unknown-mote', 'foreign-snapshot'].includes(availability) ? { scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: {
        ...current.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, ...(availability === 'unknown-mote' ? { topics: null } : { scope: 'foreign-original-directory' }) } } } : {}) })
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId, targetTabId }))
    const before = originalFacts(), modes = useAppStore.getState().viewModes
    expect(Object.keys(tabs).length).toBeGreaterThan(0); expect(current.sessions).toHaveLength(5)
    await mount(true); await act(async () => requestPmoTeamsTopicFloatingOpen())
    expect(useAppStore.getState().viewModes).toBe(modes)
    expect(originalFacts()).toEqual(before)
    expect(JSON.parse(localStorage.getItem(savedMoteKey)!)).toEqual({ open: true, targetTopicId, targetTabId })
    expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
    expect(effectiveSessionViewMode(useAppStore.getState(), neighborAgent.id)).toBe('terminal')
    expect(effectiveSessionViewMode(useAppStore.getState(), executionAgent.id)).toBe('terminal')
  })
})
