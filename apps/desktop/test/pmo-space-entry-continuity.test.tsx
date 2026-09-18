// @vitest-environment happy-dom
import { act, createElement, Fragment, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { ScratchTopics } from '../src/main/scratch-topics'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
// The contents are covered by the production-workbench process restart test, T008.
// This test keeps the actual entry, window, tree and navigation store owners.
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => createElement('div', { 'data-workbench-fixture': true }) }))
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry'
import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree'

const baseline = useAppStore.getState()
let container: HTMLDivElement, root: Root, directory: string
let pending: Promise<void>[]
let workspace: { id: string; hostId: string; path: string; name: string; kind: 'folder' }
function ControlledFloatingPanel() {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  return createElement(PmoTeamsTopicFloatingPanel, { floating, setFloating })
}
function NavigationTarget() {
  const active = useAppStore((state) => state.activeWorkspaceId)
  useEffect(() => { if (active === SCRATCH_WORKSPACE_ID) document.getElementById('full-space-focus')?.focus() }, [active])
  return createElement('button', { id: 'full-space-focus' }, 'Full Space focus')
}
function button(label: string) {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(found, label).not.toBeNull()
  return found!
}
async function settle() { await act(async () => { await Promise.all(pending); await new Promise((resolve) => setTimeout(resolve, 25)) }) }
async function render() {
  await act(async () => root.render(createElement(Fragment, null,
    createElement('button', { id: 'execution-focus' }, 'Execution input'), createElement(NavigationTarget),
    createElement(PmoTeamsTopicEntry), createElement(ControlledFloatingPanel), createElement(SpaceTopicsTree, { workspace })
  )))
  await settle()
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear(); pending = []
  directory = await mkdtemp(join(tmpdir(), 'agentmux-mote-entry-'))
  workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: directory, name: 'Topics', kind: 'folder' }
  const service = new ScratchTopics()
  await service.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  await service.renameTitle(workspace, PMO_TEAMS_TOPIC_ID, 'My coordinator')
  vi.spyOn(api.scratch, 'ensureTopic').mockImplementation(async (_id, topic) => service.ensure(workspace, topic))
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async (_id, topic) => service.ensureMote(workspace, topic))
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_id, topic) => service.read(workspace, topic))
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => service.list(workspace))
  vi.spyOn(api.scratch, 'renameTitle')
  vi.spyOn(api.sessions, 'launchTerminal')
  const open = baseline.openScratchTopic
  useAppStore.setState({ config: { ...baseline.config!, version: 9, hosts: [], executors: {}, workspaces: [workspace] },
    activeWorkspaceId: 'other-project', sessions: [], tabs: {}, layouts: {}, workspaceFileRevisions: {},
    agentFocus: { execution: { sessionId: 'execution', history: [{ sessionId: 'execution', focusedAt: 123 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { execution: 'keep this draft' },
    openScratchTopic: (...args) => { const operation = open(...args); pending.push(operation); return operation }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); window.localStorage.clear()
  vi.restoreAllMocks(); useAppStore.setState(baseline, true); await rm(directory, { recursive: true, force: true })
})
it('reuses the same durable Mote from the fixed shortcut and tree without changing execution context', async () => {
  await render()
  const execution = container.querySelector<HTMLButtonElement>('#execution-focus')!; execution.focus()
  const before = useAppStore.getState().agentFocus.execution
  await act(async () => button('Open Mote').click()); await settle()
  const first = useAppStore.getState()
  const tabs = Object.values(first.tabs)
  expect(tabs).toHaveLength(1)
  expect(tabs[0]?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(first.activeWorkspaceId).toBe('other-project')
  expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-hidden')).toBe('false')
  await act(async () => button('Close Mote').click()); await settle()
  expect(document.activeElement).toBe(execution)
  await act(async () => button('Open Mote').click()); await settle()
  await act(async () => button('Open Mote Space').click()); await settle()
  const full = useAppStore.getState()
  expect(full.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
  expect(Object.keys(full.tabs)).toEqual([tabs[0]!.id])
  expect(full.sessions).toEqual([])
  expect(full.agentFocus.execution).toEqual(before)
  expect(full.agentComposerDrafts).toEqual({ execution: 'keep this draft' })
  expect(document.activeElement?.id).toBe('full-space-focus')
  expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-hidden')).toBe('true')
  // Tree opening uses the same original tab even after another Project was selected.
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'another-project' }))
  await act(async () => container.querySelector<HTMLButtonElement>('.space-mote-row')!.click()); await settle()
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([tabs[0]!.id])
  expect(api.sessions.launchTerminal).not.toHaveBeenCalled()
  expect(api.scratch.renameTitle).not.toHaveBeenCalled()
  expect((await api.scratch.readTopic(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID))?.title).toBe('My coordinator')
})
it('keeps an explicitly selected Mote Tab when opening its full Space', async () => {
  const first = { ...createWorkbenchTab('first', { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'first-region' }), topicId: PMO_TEAMS_TOPIC_ID }
  const target = { ...createWorkbenchTab('target', { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'target-region' }), topicId: PMO_TEAMS_TOPIC_ID }
  const layout = createWorkspaceLayout('mote-group'); layout.groups[0]!.tabOrder = ['first', 'target']; layout.groups[0]!.activeTabId = 'target'
  useAppStore.setState({ tabs: { first, target }, layouts: { [SCRATCH_WORKSPACE_ID]: layout } })
  await render()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: 'target' })); await settle()
  await act(async () => button('Open Mote Space').click()); await settle()
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.activeTabId).toBe('target')
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['first', 'target'])
})
it('describes Needs you from the fixed Mote Session and keeps expanded state independent', async () => {
  const mote: SessionSnapshot = { id: 'mote-session', kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local',
    workspacePath: join(directory, 'topic--launcher--leader'), label: 'Mote', processState: 'running', createdAt: 1, updatedAt: 2,
    status: { state: 'waiting', source: 'run-process', observedAt: 2 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'mote-session', run: { runId: 'healthy-run' } } }
  useAppStore.setState({ sessions: [mote] }); await render()
  const entry = button('Open Mote')
  expect(entry.getAttribute('aria-expanded')).toBe('false')
  expect(entry.getAttribute('aria-describedby')).toBe('mote-shortcut-status')
  expect(container.querySelector('#mote-shortcut-status')?.textContent).toBe('Needs you')
  expect(entry.title).toBe('Open Mote · Needs you')
  await act(async () => useAppStore.setState({ sessions: [{ ...mote, status: { state: 'working', source: 'run-process', observedAt: 3 } }] })); await settle()
  expect(container.querySelector('#mote-shortcut-status')?.textContent).toBe('Working')
  expect(entry.getAttribute('aria-expanded')).toBe('false')
})
