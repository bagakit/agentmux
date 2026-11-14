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
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'

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

function savedVisit(sessionId: string, title: string, ageHours: number, hostId = 'local') {
  return {
    sessionId,
    focusedAt: Date.now() - ageHours * 3_600_000,
    identity: {
      name: title, kind: 'agent' as const, providerId: 'codex', hostId,
      workspacePath: workspaces[1]!.path, project: { id: 'other', name: 'Other project' },
    },
  }
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config: AppConfig = { ...composerConfig, workspaces }
  const sessions = workspaces.map(workspace => ({ ...composerSession(workspace.id), workspacePath: workspace.path }))
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspaces.find(workspace => workspace.id === id)!.path }))
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  const tabs = Object.fromEntries(workspaces.map(workspace => { const tab = createWorkbenchTab('tab-' + workspace.id,
    { kind: 'agent', phase: 'attached', regionId: 'region-' + workspace.id, workspaceId: workspace.id, sessionId: workspace.id }); return [tab.id, tab] }))
  useAppStore.setState({ config, sessions, timelines: {}, tabs, layouts: Object.fromEntries(workspaces.map(workspace =>
    [workspace.id, createWorkspaceLayout('group-' + workspace.id, ['tab-' + workspace.id])])), scratchTopicSnapshots: {}, agentNames: {},
    mainSurface: 'agents', loading: false, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { 'branch-a': 'Keep the original draft' } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture()
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('scans rootless project branches together through actual Focus filters and current/history tracks', async () => {
  const original = useAppStore.getState(), controls = original.sessions.map(session => session.control)
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(boardRows().map(row => row.dataset.projectKey)).toEqual([projectKey, focusProjectKey('local', 'other')])
  expect(boardRows().map(headingLabels)).toEqual([[repoPath, 'feature/a', 'feature/b'], ['Other project']])
  const options = await focusFilterOptions(container, 'project')
  expect(options.filter(option => option.value === projectKey)).toHaveLength(1)
  await chooseFocusFilter(container, 'project', projectKey)
  expect(boardRows()).toHaveLength(1)
  expect(boardRows()[0]!.querySelectorAll('[data-focus-zone-id] button[data-focus-project-scope-control]')).toHaveLength(2)
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

it('keeps Saved visits under one current project heading and leaves a same-name Host history separate', async () => {
  const before = useAppStore.getState()
  const unrelated = savedVisit('unrelated-past', 'Unrelated archived task', 96)
  unrelated.identity.project = { id: 'past', name: 'Historical project' }
  const history = [
    savedVisit('saved-local', 'Original local archived task', 96),
    savedVisit('saved-remote', 'Remote original task', 1, 'other'), unrelated,
  ]
  useAppStore.setState({ agentFocus: { ...before.agentFocus, execution: { ...before.agentFocus.execution, history } } })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const local = focusProjectKey('local', 'other'), remote = focusProjectKey('other', 'other')
  const frame = [...container.querySelectorAll<HTMLElement>('.focus-project-frame')].find(node => node.dataset.projectGroupKey === local)!
  expect(frame).toBeDefined()
  expect(boardRows().filter(row => row.dataset.projectKey === local)).toHaveLength(1)
  const saved = frame.querySelector<HTMLElement>('[data-project-history]')!
  expect(saved).not.toBeNull()
  const disclosure = saved.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  expect(disclosure.textContent).toContain('1')
  expect(saved.querySelector('[data-saved-focus-session]')).toBeNull()
  const past = container.querySelector<HTMLButtonElement>('[aria-label="Retained projects"]')!
  expect(past).not.toBeNull()
  await act(async () => past.click())
  expect([...container.querySelectorAll<HTMLElement>('[data-retained-project]')].map(row => row.dataset.retainedProject))
    .toEqual([focusProjectKey('local', 'past')])
  const remoteRow = boardRows().find(row => row.dataset.projectKey === remote)
  expect(remoteRow?.querySelector('[data-saved-focus-session="saved-remote"]')).toBeTruthy()
  await act(async () => disclosure.click())
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  const localCard = saved.querySelector('[data-saved-focus-session="saved-local"]')
  expect(localCard?.textContent).toContain('Original local archived task')
  expect(localCard?.querySelector('button')?.title.split('\n')[0]).toBe('Original local archived task')
  expect(saved.querySelector('[data-saved-focus-session="saved-remote"]')).toBeNull()
  expect(saved.querySelector('.focus-retained-projects__row')?.textContent).toContain('View in timeline')
  await act(async () => disclosure.click())
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Original local archived task')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(boardRows().some(row => row.dataset.projectKey === local)).toBe(false)
  const historicalProject = [...container.querySelectorAll<HTMLElement>('[data-retained-project]')].find(row => row.dataset.retainedProject === local)
  expect(historicalProject?.closest('.focus-retained-projects__project')?.textContent).toContain('Original local archived task')
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentFocus.execution.history).toBe(history)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('keeps the remaining original Saved card and its focus when the first current Session arrives', async () => {
  const before = useAppStore.getState()
  const history = [savedVisit('other', 'Saved task now observed', 1), savedVisit('still-saved', 'Keep my saved card', 2)]
  useAppStore.setState({ sessions: [], agentFocus: { ...before.agentFocus, execution: { ...before.agentFocus.execution, history } } })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const target = '[data-saved-focus-session="still-saved"] button'
  let card = container.querySelector<HTMLButtonElement>(target)!
  expect(card).not.toBeNull()
  await act(async () => card.focus())
  expect(document.activeElement).toBe(card)
  await act(async () => useAppStore.setState({ sessions: before.sessions }))
  expect(container.querySelector('[data-saved-focus-session="other"]')).toBeNull()
  expect(container.querySelector('[data-project-history] ' + target)).toBe(card)
  expect(document.activeElement).toBe(card)
  expect(container.querySelector('[data-lane-id] [data-session-id="other"]')).not.toBeNull()
  const localHistory = container.querySelector<HTMLButtonElement>('[data-project-history] button[aria-expanded]')!
  await act(async () => { localHistory.focus(); localHistory.click() })
  expect(container.querySelector(target)).toBeNull()
  await act(async () => useAppStore.setState({ sessions: [] }))
  card = container.querySelector<HTMLButtonElement>(target)!
  expect(card).not.toBeNull()
  await act(async () => card.focus())
  await act(async () => useAppStore.setState({ sessions: before.sessions }))
  expect(container.querySelector('[data-project-history] ' + target)).toBe(card)
  expect(document.activeElement).toBe(card)
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
  expect(lanes.filter(lane => lane.topicId).map(lane => lane.contextRefs.map(ref => ref.id))).toEqual([['topic-a'], ['topic-b']])
  const known = retainedWorktreeFacts([], { kind: 'git-repository', hostId: 'local', repoPath, branches: [{ name: 'feature/a', worktreePath: first.workspacePath, workspaceId: first.workspaceId, isCurrent: false }] })
  const removed = retainedWorktreeFacts(known, { kind: 'git-repository', hostId: 'local', repoPath, branches: [] })
  const [retained] = deriveFocusProjectLanes([{ ...first, workspace: undefined }], state.config, { topics: {}, worktrees: removed })
  expect(retained).toMatchObject({ projectId, labels: [repoPath, 'feature/a'], recovery: 'removed', contextRefs: (['branch-a']).map(id => ({ hostId: 'local', id })) })
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
