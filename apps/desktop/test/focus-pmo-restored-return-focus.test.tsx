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



import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry'

type OpenMode = 'restored' | 'normal' | 'closed' | 'focus-reminder'
async function fixture(mode: OpenMode = 'restored') {
  const selectedMote = mote('mote-one', mode === 'focus-reminder'), otherMote = mote('mote-two')
  const work = createWorkbenchTab('work-tab', { kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'work-region', sessionId: execution.id })
  const target: WorkbenchTab = { ...createWorkbenchTab('existing-mote-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'existing-region', sessionId: selectedMote.id }), topicId: PMO_TEAMS_TOPIC_ID }
  const tabs = { [work.id]: work, [target.id]: target }
  const layouts = { project: createWorkspaceLayout('work-group', [work.id]), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [target.id]) }
  useAppStore.setState({ sessions: [execution, selectedMote, otherMote], tabs, layouts, agentSteerQueues: {} })
  const executionFocus = useAppStore.getState().agentFocus.execution
  const ensure = vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID, directoryPath: selectedMote.workspacePath, topicPath: `${selectedMote.workspacePath}/topic.md`, title: 'Mote', summary: '', collaborators: [] })
  const open = vi.spyOn(useAppStore.getState(), 'openScratchTopic').mockResolvedValue(undefined)
  const launch = vi.spyOn(useAppStore.getState(), 'launchAgent'), submit = vi.spyOn(api.sessions, 'submitPrompt')
  if (mode === 'restored') window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({
    open: true, targetTabId: target.id, maximized: false, position: { left: 80, top: 72 }, size: { width: 720, height: 520 }
  }))
  // Hydrated open has no invented prior opener or open event. The actual compact
  // entry and actual floating each consume their existing Hook, as in App/compact.
  await act(async () => root.render(createElement(Fragment, null,
    createElement(PmoTeamsTopicEntry), createElement(GlobalFocusSurface), createElement(Floating))))
  const launcher = container.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')!
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  const dialog = container.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')!
  expect(container.querySelectorAll('[data-pmo-teams-topic-launcher] button')).toHaveLength(1)
  expect(launcher).toBeTruthy(); expect(search).toBeTruthy(); expect(dialog).toBeTruthy()
  expect(launcher.closest('[aria-hidden="true"]')).toBeNull(); expect(search.closest('[aria-hidden="true"]')).toBeNull()
  if (mode !== 'restored') expect(dialog.getAttribute('aria-hidden')).toBe('true')
  if (mode === 'normal' || mode === 'focus-reminder') {
    const trigger = mode === 'normal' ? launcher : container.querySelector<HTMLButtonElement>('.focus-pmo-attention')!
    expect(trigger).toBeTruthy(); trigger.focus(); expect(document.activeElement).toBe(trigger)
    await act(async () => trigger.click())
  }
  if (mode !== 'closed') {
    expect(dialog.getAttribute('aria-hidden')).toBe('false'); expect(document.activeElement).toBe(dialog)
    expect(container.querySelector('[data-pmo-workbench-target]')?.getAttribute('data-pmo-workbench-target')).toBe(target.id)
    expect(ensure).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
    expect(open).toHaveBeenCalledWith(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: target.id })
  }
  expect(useAppStore.getState().agentFocus.execution).toBe(executionFocus)
  return { launcher, search, dialog, selectedMote, original: useAppStore.getState(), tabs, layouts, launch, submit }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function preserve(h: Fixture) {
  expect(useAppStore.getState().agentFocus.execution).toBe(h.original.agentFocus.execution)
  expect(useAppStore.getState().agentComposerDrafts).toBe(h.original.agentComposerDrafts)
  expect(useAppStore.getState().tabs).toBe(h.tabs); expect(useAppStore.getState().layouts).toBe(h.layouts)
  expect(useAppStore.getState().sessions.map(s => [s.id, s.control.run.runId])).toEqual([
    ['execution', 'execution-run'], ['mote-one', 'mote-one-run'], ['mote-two', 'mote-two-run']
  ])
  expect(h.launch).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled()
}
async function frame() {
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
}
async function settle(h: Fixture, later?: HTMLElement, restoreFocus = true) {
  const close = h.dialog.querySelector<HTMLButtonElement>('button[title="Close"]')!
  expect(close).toBeTruthy(); close.focus()
  await act(async () => {
    if (restoreFocus) close.click()
    else requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    later?.focus(); if (later) expect(document.activeElement).toBe(later)
  })
  await frame(); expect(h.dialog.getAttribute('aria-hidden')).toBe('true'); preserve(h)
}
it('restored open without a provable prior opener closes to the current stable Mote entry', async () => {
  const h = await fixture(); const focus = vi.spyOn(h.launcher, 'focus')
  await settle(h)
  expect(document.activeElement).toBe(h.launcher)
  expect(h.launcher.getAttribute('aria-label')).toBe('Open Mote')
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
})
it('restored Close preserves a later explicit visible Focus search selection', async () => {
  const h = await fixture(); const focus = vi.spyOn(h.launcher, 'focus')
  await settle(h, h.search)
  expect(document.activeElement).toBe(h.search); expect(focus).not.toHaveBeenCalled()
})
it('normal opening from the actual Mote entry returns to that actual prior opener', async () => {
  const h = await fixture('normal'); await settle(h)
  expect(document.activeElement).toBe(h.launcher)
})
it('restored restoreFocus false performs no default entry handoff', async () => {
  const h = await fixture(); const focus = vi.spyOn(h.launcher, 'focus')
  await settle(h, undefined, false)
  expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(document.body)
})
it('an unsolicited Close while already closed performs no default entry handoff', async () => {
  const h = await fixture('closed'); const focus = vi.spyOn(h.launcher, 'focus')
  expect(document.activeElement).toBe(document.body)
  await act(async () => requestPmoTeamsTopicFloatingClose()); await frame(); preserve(h)
  expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(document.body)
})
it('a missing existing launcher produces no invented control or focus target', async () => {
  const h = await fixture()
  // Remove the actual Entry through React, preserving the existing Global and
  // Floating sibling slots rather than mutating React-owned DOM during teardown.
  await act(async () => root.render(createElement(Fragment, null, null, createElement(GlobalFocusSurface), createElement(Floating))))
  expect(container.querySelector('[data-pmo-teams-topic-launcher] button')).toBeNull()
  await settle(h)
  expect(document.activeElement).toBe(document.body)
  expect(container.querySelector('[data-pmo-teams-topic-launcher] button')).toBeNull()
})
it.each(['hidden', 'aria-hidden', 'inert', 'disabled'] as const)('restored Close does not target an explicitly %s entry', async (state) => {
  const h = await fixture(); const wrapper = h.launcher.closest<HTMLElement>('[data-pmo-teams-topic-launcher]')!
  const focus = vi.spyOn(h.launcher, 'focus')
  if (state === 'disabled') h.launcher.disabled = true
  else wrapper.setAttribute(state, state === 'aria-hidden' ? 'true' : '')
  await settle(h)
  expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(document.body)
})
it('a launcher button without its existing aria-controls relationship is not a return target', async () => {
  const h = await fixture(); const focus = vi.spyOn(h.launcher, 'focus'); h.launcher.removeAttribute('aria-controls')
  await settle(h)
  expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(document.body)
})
it('an existing Focus callback which yields to the current main surface is not replaced by the default launcher', async () => {
  const h = await fixture('focus-reminder')
  const coreFact: AgentMuxAgentSession = {
    kind: 'agent', agentSessionId: h.selectedMote.id, providerId: h.selectedMote.providerId, executorId: h.selectedMote.executorId,
    hostId: h.selectedMote.hostId, workspacePath: h.selectedMote.workspacePath, run: h.selectedMote.control.run,
    retiredRuns: [], createdAt: h.selectedMote.createdAt, updatedAt: 4,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 4 }
  }
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-session', session: coreFact } }))
  expect(container.querySelector('.focus-pmo-attention')).toBeNull()
  // Stale mounted Global deliberately remains; this qualifies the callback's
  // execution-time surface guard, not real App unmount or a between-frame switch.
  await act(async () => useAppStore.setState({ mainSurface: 'board' }))
  const launcherFocus = vi.spyOn(h.launcher, 'focus'), searchFocus = vi.spyOn(h.search, 'focus')
  await settle(h)
  expect(launcherFocus).not.toHaveBeenCalled(); expect(searchFocus).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(document.body)
})
it('a Close frame yields to the actual same floating after it has reopened', async () => {
  const h = await fixture(); const focus = vi.spyOn(h.launcher, 'focus')
  const close = h.dialog.querySelector<HTMLButtonElement>('button[title="Close"]')!
  expect(close).toBeTruthy(); close.focus()
  await act(async () => {
    close.click(); requestPmoTeamsTopicFloatingOpen(); requestPmoTeamsTopicFloatingOpen()
  })
  expect(h.dialog.getAttribute('aria-hidden')).toBe('false'); expect(document.activeElement).toBe(h.dialog)
  await frame(); preserve(h)
  expect(document.activeElement).toBe(h.dialog); expect(focus).not.toHaveBeenCalled()
})
it('a known connected primary entry takes priority over its optional callback', async () => {
  const h = await fixture('closed'), callback = vi.fn()
  h.launcher.focus(); expect(document.activeElement).toBe(h.launcher)
  await act(async () => requestPmoTeamsTopicFloatingOpen({ onReturnFocus: callback }))
  expect(h.dialog.getAttribute('aria-hidden')).toBe('false'); expect(document.activeElement).toBe(h.dialog)
  await settle(h)
  expect(callback).not.toHaveBeenCalled(); expect(document.activeElement).toBe(h.launcher)
})
