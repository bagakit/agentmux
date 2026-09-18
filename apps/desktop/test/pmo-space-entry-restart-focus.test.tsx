// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { ScratchTopics } from '../src/main/scratch-topics'
import type { SessionSnapshot } from '../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'

// Exercise production floating-state decoding, Panel effects and navigation store over real
// private Mote files. T008 owns the real-process restart and production Workbench content gate.
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({
  WorkspaceWorkbench: ({ projectionTabId }: { projectionTabId?: string }) => createElement('div', {
    'data-private-workbench-content': true, 'data-projection-tab-id': projectionTabId ?? ''
  })
}))
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'

function ControlledFloatingPanel() {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  return createElement(PmoTeamsTopicFloatingPanel, { floating, setFloating })
}

const baseline = useAppStore.getState()
const floatingStorageKey = 'agentmux.leader-topic-floating.v1'
const projectId = 'execution-project'
let directory: string, container: HTMLDivElement, root: Root
let pending: Promise<void>[]

function session(id: string, workspacePath: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local',
    workspacePath, label: id, processState: 'running', createdAt: 1, updatedAt: 2,
    status: { state: 'working', source: 'run-process', observedAt: 2 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `healthy-${id}` } } }
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear(); pending = []
  directory = await mkdtemp(join(tmpdir(), 'agentmux-mote-focus-'))
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: directory, name: 'Topics', kind: 'folder' as const }
  const project = { id: projectId, hostId: 'local', path: join(directory, 'project'), name: 'Project', kind: 'folder' as const }
  const topics = new ScratchTopics()
  const mote = await topics.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  const home = join(directory, mote.directoryPath)
  vi.spyOn(api.scratch, 'ensureTopic').mockImplementation(async (_workspace, id) => topics.ensure(workspace, id))
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async (_workspace, id) => topics.ensureMote(workspace, id))
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => topics.read(workspace, id))
  vi.spyOn(api.sessions, 'launchAgent')
  vi.spyOn(api.sessions, 'launchTerminal')
  const first = { ...createWorkbenchTab('first', { kind: 'agent', phase: 'attached', workspaceId: workspace.id,
    sessionId: 'first-session', regionId: 'first-region' }), topicId: PMO_TEAMS_TOPIC_ID }
  const target = { ...createWorkbenchTab('target', { kind: 'agent', phase: 'attached', workspaceId: workspace.id,
    sessionId: 'target-session', regionId: 'target-region' }), topicId: PMO_TEAMS_TOPIC_ID }
  const execution = createWorkbenchTab('execution-tab', { kind: 'agent', phase: 'attached', workspaceId: project.id,
    sessionId: 'execution-session', regionId: 'execution-region' })
  const moteLayout = createWorkspaceLayout('mote-group', ['first', 'target'])
  moteLayout.groups[0]!.activeTabId = 'first'; moteLayout.groups[0]!.recentTabIds = ['first', 'target']
  const projectLayout = createWorkspaceLayout('execution-group', ['execution-tab'])
  const open = baseline.openScratchTopic
  useAppStore.setState({ config: { ...baseline.config!, version: 9, hosts: [], executors: {}, workspaces: [workspace, project] },
    activeWorkspaceId: project.id, mainSurface: 'workbench',
    tabs: { first, target, [execution.id]: execution }, layouts: { [workspace.id]: moteLayout, [project.id]: projectLayout },
    sessions: [session('first-session', home), session('target-session', home), session('execution-session', project.path)],
    agentFocus: { execution: { sessionId: 'execution-session', history: [{ sessionId: 'execution-session', focusedAt: 123 }] },
      pmo: { sessionId: 'target-session' } },
    agentComposerDrafts: { 'execution-session': 'keep the original unsent request' },
    workspaceFileRevisions: {},
    openScratchTopic: (...args) => { const operation = open(...args); pending.push(operation); return operation }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); window.localStorage.clear()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(baseline, true)
  await rm(directory, { recursive: true, force: true })
})

async function freshMount(targetTabId?: string, sessionsPending = false) {
  window.localStorage.setItem(floatingStorageKey, JSON.stringify({ open: true, maximized: false,
    position: { left: 80, top: 72 }, size: { width: 720, height: 520 }, ...(targetTabId ? { targetTabId } : {}) }))
  const before = useAppStore.getState()
  const original = structuredClone({ tabs: before.tabs, layouts: before.layouts, activeWorkspaceId: before.activeWorkspaceId,
    execution: before.agentFocus.execution, drafts: before.agentComposerDrafts })
  expect(Object.keys(original.tabs)).toEqual(['first', 'target', 'execution-tab'])
  expect(before.sessions.map(one => one.id)).toEqual(sessionsPending ? [] : ['first-session', 'target-session', 'execution-session'])
  expect(before.agentFocus.pmo.sessionId).toBe(targetTabId ? 'first-session' : 'target-session')
  await act(async () => root.render(createElement(ControlledFloatingPanel)))
  await act(async () => { await Promise.all(pending); await new Promise(resolve => setTimeout(resolve, 25)) })
  const restored = useAppStore.getState()
  expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-hidden')).toBe('false')
  expect(restored.agentFocus.pmo.sessionId).toBe('target-session')
  expect(restored.layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.activeTabId).toBe('first')
  const projected = container.querySelector('[data-private-workbench-content]')
  expect(projected).not.toBeNull()
  expect(projected?.getAttribute('data-projection-tab-id')).toBe('target')
  expect(restored.tabs).toEqual(original.tabs)
  expect(restored.layouts).toEqual(original.layouts)
  expect(restored.activeWorkspaceId).toBe(original.activeWorkspaceId)
  expect(restored.agentFocus.execution).toEqual(original.execution)
  expect(restored.agentComposerDrafts).toEqual(original.drafts)
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  expect(api.sessions.launchTerminal).not.toHaveBeenCalled()
}

it('keeps the restored explicit Mote target and main Project context on a fresh floating mount', async () => {
  useAppStore.setState({ agentFocus: { ...useAppStore.getState().agentFocus, pmo: { sessionId: 'first-session' } } })
  await freshMount('target')
})

it('keeps restored Mote focus when no explicit floating target was saved', async () => {
  await freshMount()
})

it('keeps the durable Mote Tab and focus before an empty startup projection receives Session facts', async () => {
  const canonicalSessions = useAppStore.getState().sessions
  expect(canonicalSessions.map(one => one.id)).toEqual(['first-session', 'target-session', 'execution-session'])
  useAppStore.setState({ sessions: [] })
  await freshMount(undefined, true)
  const beforeFacts = structuredClone({ layouts: useAppStore.getState().layouts,
    execution: useAppStore.getState().agentFocus.execution, drafts: useAppStore.getState().agentComposerDrafts })
  await act(async () => useAppStore.setState({ sessions: canonicalSessions }))
  await act(async () => { await Promise.all(pending); await new Promise(resolve => setTimeout(resolve, 25)) })
  const afterFacts = useAppStore.getState()
  expect(afterFacts.agentFocus.pmo.sessionId).toBe('target-session')
  expect(afterFacts.layouts).toEqual(beforeFacts.layouts)
  expect(afterFacts.activeWorkspaceId).toBe(projectId)
  expect(afterFacts.agentFocus.execution).toEqual(beforeFacts.execution)
  expect(afterFacts.agentComposerDrafts).toEqual(beforeFacts.drafts)
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  expect(api.sessions.launchTerminal).not.toHaveBeenCalled()
})
