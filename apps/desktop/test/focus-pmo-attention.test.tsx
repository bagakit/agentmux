// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { addWorkbenchRegion, createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
// The production floating window, target selection and Store remain mounted.
// This bounded flow does not qualify its workbench contents or a native Provider.
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({
  WorkspaceWorkbench: ({ projectionTabId }: { projectionTabId?: string }) => createElement('output', { 'data-pmo-workbench-target': projectionTabId })
}))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const execution: Agent = {
  id: 'execution', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/project',
  label: 'Keep working', createdAt: 1, updatedAt: 2, agentSessionUpdatedAt: 2, processState: 'running', latestOutputBytes: 0,
  status: { state: 'working', source: 'native-hook', observedAt: 2 },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'execution', run: { runId: 'execution-run' } }
}
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {},
  workspaces: [
    { id: 'project', hostId: 'local', name: 'Project', path: '/project', kind: 'folder' },
    { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: '/topics', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
function mote(id: string, pending = false): Agent {
  return {
    ...execution, id, label: id, workspacePath: '/topics/topic--launcher--leader',
    status: { state: 'working', source: 'native-hook', observedAt: 3 },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `${id}-run` } },
    ...(pending ? { pendingInteraction: {
      kind: 'question' as const, id: `request-${id}`, agentSessionId: id,
      evidence: { source: 'native-hook' as const, observedAt: 3, run: { runId: `${id}-run` }, hookReceiptId: `receipt-${id}` },
      questions: [{ id: 'release', title: 'Release?', prompt: 'Which release?', options: [{ id: 'stable', label: 'Stable' }] }]
    } } : {})
  }
}
function Floating() {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  return createElement(PmoTeamsTopicFloatingPanel, { floating, setFloating })
}
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  useAppStore.setState({ config, sessions: [execution, mote('mote-one'), mote('mote-two')], tabs: {}, layouts: {}, timelines: {},
    activeWorkspaceId: 'project', mainSurface: 'agents', agentComposerDrafts: { execution: 'My unsent draft' },
    agentFocus: { execution: { sessionId: execution.id, history: [{ sessionId: execution.id, focusedAt: 123 }] }, pmo: { sessionId: null } }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); window.localStorage.clear()
  vi.restoreAllMocks(); useAppStore.setState(baseline, true)
})

it('publishes PMO request changes in the mounted Focus without any execution change', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const original = useAppStore.getState()
  const card = container.querySelector('.focus-context[data-session-id="execution"]')
  expect(card).not.toBeNull()
  expect(container.querySelector('.focus-pmo-attention')).toBeNull()
  const cases: Array<[string[], string | null]> = [
    [['mote-one'], 'Mote· 1 to review'],
    [['mote-one', 'mote-two'], 'Mote· 2 to review'],
    [['mote-two'], 'Mote· 1 to review'],
    [[], null]
  ]
  for (const [pending, label] of cases) {
    // Typed Core publication fixture; no new output, tab, focus or timeline event.
    await act(async () => useAppStore.setState({ sessions: [execution, mote('mote-one', pending.includes('mote-one')), mote('mote-two', pending.includes('mote-two'))] }))
    const attention = container.querySelector('.focus-pmo-attention')
    if (label) expect(attention?.textContent).toContain(label)
    else expect(attention).toBeNull()
    expect(container.querySelector('.focus-context[data-session-id="execution"]')).toBe(card)
    const state = useAppStore.getState()
    expect(state.agentFocus).toBe(original.agentFocus)
    expect(state.tabs).toBe(original.tabs)
    expect(state.agentComposerDrafts).toBe(original.agentComposerDrafts)
  }
})

it.each([false, true])('opens the original pending Mote tab and closes back to its Focus entry (split=%s)', async (split) => {
  const selectedMote = mote('mote-one', true), otherMote = mote('mote-two')
  const work = createWorkbenchTab('work-tab', { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'work-region', sessionId: execution.id })
  let target: WorkbenchTab = { ...createWorkbenchTab('pending-mote-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'pending-region', sessionId: selectedMote.id }), topicId: PMO_TEAMS_TOPIC_ID }
  if (split) {
    // The first Region is a decoy: finding any Agent instead of the request owner
    // must also fail, even when its Tab and provider happen to match.
    target = { ...createWorkbenchTab(target.id, { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'other-active-region', sessionId: otherMote.id }), topicId: PMO_TEAMS_TOPIC_ID }
    target = addWorkbenchRegion(target, 'other-active-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'pending-region', sessionId: selectedMote.id })
    target = { ...target, layout: { ...target.layout, activeRegionId: 'other-active-region' } }
    expect(Object.keys(target.regions)).toEqual(['other-active-region', 'pending-region'])
  }
  const decoy = { ...createWorkbenchTab('other-mote-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'other-region', sessionId: otherMote.id }), topicId: PMO_TEAMS_TOPIC_ID }
  const tabs = { [work.id]: work, [decoy.id]: decoy, [target.id]: target }
  const layouts = { project: createWorkspaceLayout('work-group', [work.id]), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [decoy.id, target.id]) }
  useAppStore.setState({ sessions: [execution, selectedMote, otherMote], tabs, layouts })
  const ensure = vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID, directoryPath: selectedMote.workspacePath, topicPath: `${selectedMote.workspacePath}/topic.md`, title: 'Mote', summary: '', collaborators: [] })
  const open = vi.spyOn(useAppStore.getState(), 'openScratchTopic').mockResolvedValue(undefined)
  const launch = vi.spyOn(useAppStore.getState(), 'launchAgent')
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await act(async () => root.render(createElement(Fragment, null, createElement(GlobalFocusSurface), createElement(Floating))))
  const original = useAppStore.getState()
  const entry = container.querySelector<HTMLButtonElement>('.focus-pmo-attention')!
  expect(entry?.textContent).toContain('Mote· 1 to review')
  entry.focus()
  await act(async () => entry.click())
  const dialog = container.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')!
  expect(dialog.getAttribute('data-state')).toBe('open')
  expect(document.activeElement).toBe(dialog)
  expect(container.querySelector('[data-pmo-workbench-target]')?.getAttribute('data-pmo-workbench-target')).toBe(target.id)
  expect(useAppStore.getState().agentFocus.pmo.sessionId).toBe(selectedMote.id)
  expect(useAppStore.getState().tabs[target.id]?.layout.activeRegionId).toBe('pending-region')
  expect(ensure).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
  expect(open).toHaveBeenCalledExactlyOnceWith(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: target.id })
  const close = dialog.querySelector<HTMLButtonElement>('button[title="Close"]')!
  expect(close).not.toBeNull()
  close.focus()
  await act(async () => close.click())
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(dialog.getAttribute('data-state')).toBe('closed')
  expect(document.activeElement).toBe(entry)
  const state = useAppStore.getState()
  expect(state.agentFocus.execution).toBe(original.agentFocus.execution)
  expect(state.tabs[work.id]).toBe(work)
  expect(state.tabs[decoy.id]).toBe(decoy)
  expect(state.tabs[target.id]?.regions).toBe(target.regions)
  expect(state.tabs[target.id]?.layout.root).toBe(target.layout.root)
  expect(state.layouts.project).toBe(layouts.project)
  if (!split) { expect(state.tabs).toBe(tabs); expect(state.layouts).toBe(layouts) }
  expect(state.sessions).toEqual([execution, selectedMote, otherMote])
  expect(state.agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(state.activeWorkspaceId).toBe('project')
  expect(state.mainSurface).toBe('agents')
  expect(launch).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('changes only the PMO projection with no execution Tab reads at both input sizes', () => {
  for (const count of [14, 112]) {
    const terminals = Array.from({ length: count }, (_, index): Extract<SessionSnapshot, { kind: 'terminal' }> => ({
      id: `terminal-${index}`, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/project', label: 'Terminal',
      createdAt: 1, updatedAt: 2, processState: 'running', latestOutputBytes: 0,
      status: { state: 'running', source: 'run-process', observedAt: 2 },
      control: { kind: 'terminal', hostId: 'local', runId: `terminal-${index}`, run: { runId: `terminal-${index}` } }
    }))
    const records: Record<string, WorkbenchTab> = Object.fromEntries(terminals.map(terminal => [terminal.id,
      createWorkbenchTab(terminal.id, { kind: 'terminal', phase: 'attached', workspaceId: 'project', regionId: `${terminal.id}-region`, sessionId: terminal.id })
    ]))
    let tabReads = 0
    const tabs = new Proxy(records, { get(target, key, receiver) { if (typeof key === 'string' && key in target) tabReads++; return Reflect.get(target, key, receiver) } })
    const select = createFocusProjectionSelector()
    const input = { config, sessions: [...terminals, mote('mote-one')], tabs, timelines: {}, agentNames: {}, scratchTopicSnapshots: {} }
    const initial = select(input)
    expect(initial.contexts).toEqual([])
    expect(initial.pmoAttention).toEqual([])
    expect(tabReads).toBe(0)
    tabReads = 0
    const pending = select({ ...input, sessions: [...terminals, mote('mote-one', true)] })
    expect(pending.pmoAttention).toEqual(['mote-one'])
    expect(pending.contexts).toBe(initial.contexts)
    expect(pending.laneContexts).toBe(initial.laneContexts)
    expect(tabReads).toBe(0)
    const resolved = select(input)
    expect(resolved.pmoAttention).toEqual([])
    expect(resolved.contexts).toBe(initial.contexts)
    expect(resolved.laneContexts).toBe(initial.laneContexts)
    expect(tabReads).toBe(0)
    expect(select({ ...input })).toBe(resolved)
  }
})
