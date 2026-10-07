// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { chooseFocusFilter, focusFilterOptions } from './fixtures/focus-filter-menu'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { directoryIdentity } from '../src/shared/space-addresses'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes, deriveRetainedFocusProjects, focusProjectKey, retainedWorktreeFacts } from '../src/renderer/src/lib/focus-project-lanes'
import { observeFocusHistoryIdentity } from '../src/renderer/src/lib/focus-history-identity'
import { groupFocusTimeline } from '../src/renderer/src/lib/focus-history-timeline'
import { focusTimeSegments } from '../src/renderer/src/lib/focus-time-window'

// Keep Store, Focus, project filters, lanes and the timeline real. PTY paint is unrelated.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const baseline = useAppStore.getState()
const repoPath = fixturePath('project-without-root-workspace')
const projectId = directoryIdentity('local', repoPath)
const projectKey = focusProjectKey('local', projectId)
const workspaces: WorkspaceRecord[] = [
  { id: 'branch-a', name: 'Checkout title A', hostId: 'local', kind: 'worktree', path: fixturePath('checkout-a'), repoPath, branch: 'feature/a' },
  { id: 'other', name: 'Other project', hostId: 'local', kind: 'folder', path: fixturePath('other-project') },
  { id: 'branch-b', name: 'Checkout title B', hostId: 'local', kind: 'worktree', path: fixturePath('checkout-b'), repoPath, branch: 'feature/b' }
]
let root: Root, container: HTMLDivElement
const projection = () => createFocusProjectionSelector()(useAppStore.getState()).laneContexts
const boardRows = () => [...container.querySelectorAll<HTMLElement>('.focus-project-board__live .focus-project-lanes__row')]
const headingLabels = (lane: HTMLElement) => [...lane.querySelectorAll('.focus-project-lanes__label')].map(label => label.textContent)
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config: AppConfig = { ...composerConfig, workspaces }
  const sessions = workspaces.map(workspace => ({ ...composerSession(workspace.id), workspacePath: workspace.path }))
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspaces.find(workspace => workspace.id === id)!.path }))
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  useAppStore.setState({ config, sessions, timelines: {}, tabs: {}, layouts: {}, scratchTopicSnapshots: {}, agentNames: {},
    mainSurface: 'agents', loading: false, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { 'branch-a': 'Keep the original draft' } })
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('scans rootless project branches together through actual Focus filters and current/history tracks', async () => {
  const original = useAppStore.getState(), controls = original.sessions.map(session => session.control)
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(boardRows().map(row => row.dataset.projectKey)).toEqual([projectKey, projectKey, focusProjectKey('local', 'other')])
  expect(boardRows().map(headingLabels)).toEqual([[repoPath, 'feature/a'], [repoPath, 'feature/b'], ['Other project']])
  const options = await focusFilterOptions(container, 'project')
  expect(options.filter(option => option.value === projectKey)).toHaveLength(1)
  await chooseFocusFilter(container, 'project', projectKey)
  expect(boardRows()).toHaveLength(2)
  expect([...container.querySelectorAll<HTMLElement>('.focus-context[data-session-id]')].map(row => row.dataset.sessionId)).toEqual(['branch-a', 'branch-b'])
  await act(async () => { useAppStore.getState().focusExecutionSession('branch-a', undefined, { navigate: false }) })
  const state = useAppStore.getState(), entry = state.agentFocus.execution.history[0]!
  expect(entry.identity?.project).toEqual({ id: projectId, name: repoPath })
  const lanes = deriveFocusProjectLanes(projection(), state.config)
  const groups = groupFocusTimeline(projection(), lanes, focusTimeSegments([entry], { start: entry.focusedAt - 1, end: entry.focusedAt + 1 }, entry.focusedAt))
  const group = groups.find(item => item.key === projectKey)!
  expect(group.tracks.map(track => track.sessionId)).toEqual(['branch-a', 'branch-b'])
  expect(group.tracks[0]!.segments).toHaveLength(1)
  expect(deriveRetainedFocusProjects([entry], lanes)).toEqual([])
  const timeline = [...container.querySelectorAll<HTMLElement>('[data-timeline-project]')].find(row => row.dataset.timelineProject === projectKey)
  expect(timeline).toBeTruthy()
  expect(state.sessions.map(session => session.control)).toEqual(controls)
  expect(state.agentComposerDrafts['branch-a']).toBe('Keep the original draft')
})

it('keeps registered-root identities and stable branch adjacency when project activity ties', () => {
  const state = useAppStore.getState(), registered = { id: 'registered-root', name: 'Confirmed Project', hostId: 'local', path: repoPath, kind: 'folder' as const }
  const config = { ...state.config!, workspaces: [...workspaces, registered] }
  const rows = createFocusProjectionSelector()({ ...state, config }).laneContexts
  for (const lastActivityAt of [null, Date.now() - 1000, Date.now() - 100 * 3_600_000]) {
    const lanes = deriveFocusProjectLanes(rows.map(row => ({ ...row, lastActivityAt })), config)
    expect(lanes.map(lane => lane.projectId)).toEqual(['registered-root', 'registered-root', 'other'])
    expect(lanes.slice(0, 2).map(lane => lane.labels[0])).toEqual(['Confirmed Project', 'Confirmed Project'])
  }
  expect(observeFocusHistoryIdentity(state.sessions[0]!, config).project).toEqual({ id: 'registered-root', name: 'Confirmed Project' })
  expect(rows.map(row => row.id)).toEqual(['branch-a', 'other', 'branch-b'])
})

it('separates Hosts, repositories, Topics and unknown membership while retaining removed checkout facts', () => {
  const state = useAppStore.getState(), rows = projection(), first = rows[0]!
  const remote = { ...workspaces[0]!, id: 'remote', hostId: 'remote' }
  const different = { ...workspaces[0]!, id: 'different-repo', repoPath: fixturePath('another-repository') }
  const variants = [
    first,
    { ...first, id: 'remote-agent', hostId: 'remote', workspace: remote, workspaceId: remote.id },
    { ...first, id: 'different-agent', workspace: different, workspaceId: different.id },
    { ...first, id: 'unknown', workspace: undefined, workspaceId: 'unknown-workspace', workspacePath: fixturePath('project-without-root-workspace/unknown-child') },
    { ...first, id: 'topic-a', topicId: 'launcher:alpha' },
    { ...first, id: 'topic-b', topicId: 'launcher:beta' }
  ]
  const lanes = deriveFocusProjectLanes(variants, { ...state.config!, workspaces: [...workspaces, remote, different] })
  expect(lanes).toHaveLength(6)
  expect(new Set(lanes.filter(lane => !lane.topicId).map(lane => focusProjectKey(lane.hostId, lane.projectId))).size).toBe(4)
  expect(lanes.filter(lane => lane.topicId).map(lane => lane.contextIds)).toEqual([['topic-a'], ['topic-b']])
  const known = retainedWorktreeFacts([], { kind: 'git-repository', hostId: 'local', repoPath, branches: [{ name: 'feature/a', worktreePath: first.workspacePath, workspaceId: first.workspaceId, isCurrent: false }] })
  const removed = retainedWorktreeFacts(known, { kind: 'git-repository', hostId: 'local', repoPath, branches: [] })
  const [retained] = deriveFocusProjectLanes([{ ...first, workspace: undefined }], state.config, { topics: {}, worktrees: removed })
  expect(retained).toMatchObject({ projectId, labels: [repoPath, 'feature/a'], recovery: 'removed', contextIds: ['branch-a'] })
})

it('preserves old historical project observations when a new rootless project identity becomes confirmed', () => {
  const state = useAppStore.getState(), rows = projection(), lanes = deriveFocusProjectLanes(rows, state.config)
  const prior = { sessionId: rows[0]!.id, focusedAt: Date.now() - 1000, identity: { ...observeFocusHistoryIdentity(state.sessions[0]!, state.config), project: { id: 'previously-observed-project', name: 'Previous observation' } } }
  const copy = structuredClone(prior)
  expect(deriveRetainedFocusProjects([prior], lanes).map(project => project.projectId)).toEqual(['previously-observed-project'])
  const groups = groupFocusTimeline(rows, lanes, focusTimeSegments([prior], { start: prior.focusedAt - 1, end: Date.now() + 1 }, Date.now()))
  expect(groups.find(group => group.key === focusProjectKey('local', 'previously-observed-project'))?.tracks[0]?.segments).toHaveLength(1)
  expect(groups.find(group => group.key === projectKey)?.tracks.map(track => track.sessionId)).toEqual(['branch-a', 'branch-b'])
  expect(prior).toEqual(copy)
})
