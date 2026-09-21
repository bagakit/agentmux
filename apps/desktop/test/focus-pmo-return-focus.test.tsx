// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession } from '../../../packages/core/src/types'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
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
  vi.restoreAllMocks(); useAppStore.setState(baseline, true); vi.unstubAllGlobals()
})


async function floatingFixture() {
  const selectedMote = mote('mote-one', true), otherMote = mote('mote-two')
  const work = createWorkbenchTab('work-tab', { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'work-region', sessionId: execution.id })
  const target: WorkbenchTab = { ...createWorkbenchTab('pending-mote-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'pending-region', sessionId: selectedMote.id }), topicId: PMO_TEAMS_TOPIC_ID }
  const tabs = { [work.id]: work, [target.id]: target }
  const layouts = { project: createWorkspaceLayout('work-group', [work.id]), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [target.id]) }
  useAppStore.setState({ sessions: [execution, selectedMote, otherMote], tabs, layouts, agentSteerQueues: {} })
  const ensure = vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID, directoryPath: selectedMote.workspacePath, topicPath: `${selectedMote.workspacePath}/topic.md`, title: 'Mote', summary: '', collaborators: [] })
  const open = vi.spyOn(useAppStore.getState(), 'openScratchTopic').mockResolvedValue(undefined)
  const launch = vi.spyOn(useAppStore.getState(), 'launchAgent')
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await act(async () => root.render(createElement(Fragment, null, createElement(GlobalFocusSurface), createElement(Floating))))
  const original = useAppStore.getState()
  const entry = container.querySelector<HTMLButtonElement>('.focus-pmo-attention')!
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  expect(entry?.textContent).toContain('Mote · 1 to review'); expect(search).toBeTruthy()
  entry.focus(); await act(async () => entry.click())
  const dialog = container.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')!
  expect(dialog.getAttribute('aria-hidden')).toBe('false'); expect(document.activeElement).toBe(dialog)
  expect(container.querySelector('[data-pmo-workbench-target]')?.getAttribute('data-pmo-workbench-target')).toBe(target.id)
  expect(useAppStore.getState().agentFocus.pmo.sessionId).toBe(selectedMote.id)
  expect(ensure).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
  expect(open).toHaveBeenCalledExactlyOnceWith(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: target.id })
  const close = dialog.querySelector<HTMLButtonElement>('button[title="Close"]')!
  expect(close).toBeTruthy()
  return { selectedMote, original, tabs, layouts, entry, search, dialog, close, launch, submit }
}
type Fixture = Awaited<ReturnType<typeof floatingFixture>>
async function confirmPending(h: Fixture) {
  const coreFact: AgentMuxAgentSession = {
    kind: 'agent', agentSessionId: h.selectedMote.id, providerId: h.selectedMote.providerId, executorId: h.selectedMote.executorId,
    hostId: h.selectedMote.hostId, workspacePath: h.selectedMote.workspacePath, run: h.selectedMote.control.run,
    retiredRuns: [], createdAt: h.selectedMote.createdAt, updatedAt: 4,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 4 }
  }
  // Typed Core publication into the actual renderer reducer. This confirms the
  // UI contract without claiming a real Provider/native receipt was produced.
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-session', session: coreFact } }))
  const projected = useAppStore.getState().sessions.find(session => session.id === h.selectedMote.id)!
  expect(projected.kind).toBe('agent')
  if (projected.kind !== 'agent') throw new Error('Actual confirmed Agent projection missing')
  expect(projected.agentSessionUpdatedAt).toBe(4); expect(projected.pendingInteraction).toBeUndefined()
  expect(container.querySelector('.focus-pmo-attention')).toBeNull(); expect(document.contains(h.entry)).toBe(false)
  expect(h.dialog.getAttribute('aria-hidden')).toBe('false')
}
async function closeAndSettle(h: Fixture, laterFocus?: HTMLElement) {
  h.close.focus()
  await act(async () => { h.close.click(); laterFocus?.focus(); if (laterFocus) expect(document.activeElement).toBe(laterFocus) })
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(h.dialog.getAttribute('aria-hidden')).toBe('true')
  expect(useAppStore.getState().agentFocus.execution).toBe(h.original.agentFocus.execution)
  expect(useAppStore.getState().agentComposerDrafts).toBe(h.original.agentComposerDrafts)
  expect(useAppStore.getState().tabs).toBe(h.tabs); expect(useAppStore.getState().layouts).toBe(h.layouts)
  expect(useAppStore.getState().sessions.map(session => [session.id, session.control.run.runId])).toEqual([
    ['execution', 'execution-run'], ['mote-one', 'mote-one-run'], ['mote-two', 'mote-two-run']
  ])
  expect(h.launch).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled()
}
it('positive control: an unchanged pending opener remains connected and Close restores it', async () => {
  const h = await floatingFixture(); await closeAndSettle(h)
  expect(document.contains(h.entry)).toBe(true); expect(document.activeElement).toBe(h.entry)
})
it('typed confirmation removes the opener and Close returns DOM focus to a visible Focus control', async () => {
  const h = await floatingFixture(); await confirmPending(h); await closeAndSettle(h)
  const active = document.activeElement
  expect(active, 'After the original opener unmounts, focus must leave the hidden Mote and return to connected visible Focus controls').toBeInstanceOf(HTMLElement)
  expect(active).toBe(h.search)
  expect(active!.closest('.global-focus-surface')).not.toBeNull()
  expect(active!.closest('[aria-hidden="true"]')).toBeNull()
})
it('adjacent existing-opener branch: a later explicit Focus control selection wins over deferred Close restore', async () => {
  const h = await floatingFixture(); await closeAndSettle(h, h.search)
  expect(document.activeElement).toBe(h.search)
})
it('confirmed-opener branch: later explicit Focus selection is preserved through Close', async () => {
  const h = await floatingFixture(); await confirmPending(h); await closeAndSettle(h, h.search)
  expect(document.activeElement).toBe(h.search)
})

it('does not return to a stale Focus search after the main surface has changed', async () => {
  const h = await floatingFixture(); await confirmPending(h)
  await act(async () => useAppStore.setState({ mainSurface: 'board' }))
  expect(useAppStore.getState().mainSurface).toBe('board')
  const searchFocus = vi.spyOn(h.search, 'focus')
  await closeAndSettle(h)
  expect(searchFocus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(document.body)
})
it('restoreFocus false does not invoke the removed-opener fallback', async () => {
  const h = await floatingFixture(); await confirmPending(h)
  const searchFocus = vi.spyOn(h.search, 'focus')
  h.close.focus()
  await act(async () => requestPmoTeamsTopicFloatingClose({ restoreFocus: false }))
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(h.dialog.getAttribute('aria-hidden')).toBe('true')
  expect(searchFocus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(document.body)
  expect(useAppStore.getState().agentFocus.execution).toBe(h.original.agentFocus.execution)
})
function HookHarness() {
  const [floating] = usePmoTeamsTopicFloatingState()
  return createElement('div', null,
    createElement('button', { id: 'default-trigger' }, 'Open'),
    createElement('div', { id: 'default-panel', 'data-pmo-teams-topic-floating': true, tabIndex: -1 }),
    createElement('output', { 'data-open': String(floating.open), 'data-state-keys': Object.keys(floating).sort().join(',') })
  )
}
it('the default second-open panel focus closes to the first opener without a fallback', async () => {
  await act(async () => root.render(createElement(HookHarness)))
  const trigger = container.querySelector<HTMLButtonElement>('#default-trigger')!, panel = container.querySelector<HTMLElement>('#default-panel')!
  expect(trigger).toBeTruthy(); expect(panel).toBeTruthy(); trigger.focus()
  await act(async () => requestPmoTeamsTopicFloatingOpen())
  await act(async () => requestPmoTeamsTopicFloatingOpen())
  expect(document.activeElement).toBe(panel)
  await act(async () => requestPmoTeamsTopicFloatingClose())
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(container.querySelector<HTMLElement>('output')!.dataset.open).toBe('false')
  expect(document.activeElement).toBe(trigger)
})
it('the optional return callback remains transient and is used only after the first opener disappears', async () => {
  await act(async () => root.render(createElement(HookHarness)))
  const trigger = container.querySelector<HTMLButtonElement>('#default-trigger')!, panel = container.querySelector<HTMLElement>('#default-panel')!
  const fallback = vi.fn(), laterFallback = vi.fn()
  expect(trigger).toBeTruthy(); expect(panel).toBeTruthy(); trigger.focus()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ onReturnFocus: fallback }))
  expect(container.querySelector<HTMLElement>('output')!.dataset.stateKeys!.split(',')).toEqual(['maximized', 'open', 'pendingPrompt', 'position', 'size', 'targetTabId'])
  expect(Object.keys(JSON.parse(window.localStorage.getItem('agentmux.leader-topic-floating.v1')!)).sort()).toEqual(['maximized', 'open', 'position', 'size'])
  await act(async () => requestPmoTeamsTopicFloatingOpen({ onReturnFocus: laterFallback }))
  expect(document.activeElement).toBe(panel)
  trigger.remove()
  await act(async () => requestPmoTeamsTopicFloatingClose())
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(fallback).toHaveBeenCalledTimes(1); expect(laterFallback).not.toHaveBeenCalled()
  expect(Object.keys(JSON.parse(window.localStorage.getItem('agentmux.leader-topic-floating.v1')!)).sort()).toEqual(['maximized', 'open', 'position', 'size'])
})
it('a deferred Close frame does not take focus from the same panel after it has reopened', async () => {
  await act(async () => root.render(createElement(HookHarness)))
  const trigger = container.querySelector<HTMLButtonElement>('#default-trigger')!, panel = container.querySelector<HTMLElement>('#default-panel')!
  expect(trigger).toBeTruthy(); expect(panel).toBeTruthy(); trigger.focus()
  await act(async () => requestPmoTeamsTopicFloatingOpen())
  await act(async () => requestPmoTeamsTopicFloatingOpen())
  expect(document.activeElement).toBe(panel)
  await act(async () => {
    requestPmoTeamsTopicFloatingClose()
    requestPmoTeamsTopicFloatingOpen()
    requestPmoTeamsTopicFloatingOpen()
  })
  expect(container.querySelector<HTMLElement>('output')!.dataset.open).toBe('true')
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(document.activeElement).toBe(panel)
})
