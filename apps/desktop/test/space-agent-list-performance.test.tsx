// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import type { SessionSnapshot, ScratchTopicSnapshot } from '../src/shared/contracts'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { createWorkspaceAgentSessionsSelector, workspaceAgentSessions } from '../src/renderer/src/lib/surface-tool-dock'
import { sessionPresentationsAtPath } from '../src/renderer/src/lib/session-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const observed = vi.hoisted(() => ({ goals: [] as (readonly SessionSnapshot[])[] }))
vi.mock('../src/renderer/src/lib/focus-goal-links', async original => {
  const actual = await original<typeof import('../src/renderer/src/lib/focus-goal-links')>()
  return { ...actual, createFocusGoalLinksSelector: () => {
    const select = actual.createFocusGoalLinksSelector()
    return (input: Parameters<typeof select>[0], active: boolean) => {
      observed.goals = [...observed.goals, input.sessions]
      return select(input, active)
    }
  } }
})
vi.mock('../src/renderer/src/components/WorkspaceFilesTool', () => ({ WorkspaceFilesTool: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceGitTool', () => ({ WorkspaceGitTool: () => null }))

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
function measured(sessions: SessionSnapshot[]) {
  const cost = { directoryPasses: 0, filters: 0 }
  const source = new Proxy(sessions, { get(target, key, receiver) {
    if (key === 'filter') cost.filters++
    if (key === Symbol.iterator) return function* () { cost.directoryPasses++; yield* target }
    return Reflect.get(target, key, receiver)
  } })
  return { source, cost }
}
const members = [composerSession('related-a'), composerSession('related-b')]
const outside = Array.from({ length: 2000 }, (_, i) => ({ ...composerSession(`unrelated-${i}`), workspacePath: fixturePath(`outside/${i}`) }))
const ids = (sessions: readonly SessionSnapshot[]) => sessions.map(session => session.id).sort()
beforeEach(() => {
  observed.goals = []
  useAppStore.setState({ config: composerConfig, sessions: [], tabs: {}, layouts: {}, timelines: {}, agentNames: {},
    scratchTopicSnapshots: {}, workspaceAgentOrder: {}, demands: {}, mainSurface: 'workbench', activeWorkspaceId: workspace.id,
    workspaceTool: 'agents', projectRailOpen: true, agentComposerDrafts: { [members[0]!.id]: 'Original unsent draft' } })
})

it('shares one immutable directory pass across list scopes and reuses each local result on unrelated publications', () => {
  const { source, cost } = measured([...members, ...outside])
  const scopes = Array.from({ length: 12 }, (_, i) => ({ ...workspace, id: `scope-${i}`,
    path: i ? outside[i]!.workspacePath : workspace.path }))
  const selectors = scopes.map(() => createWorkspaceAgentSessionsSelector())
  const first = selectors.map((select, i) => select(source, scopes[i]!))
  for (let update = 0; update < 40; update++) selectors.forEach((select, i) => expect(select(source, scopes[i]!)).toBe(first[i]))
  expect(first[0]).toEqual(members)
  expect(first.slice(1).every(result => result.length === 1)).toBe(true)
  expect(cost).toEqual({ directoryPasses: 1, filters: 0 })
  // A different consumer's scoped snapshot cannot evict the original shared index.
  sessionPresentationsAtPath(first[0]!, workspace.hostId, workspace.path)
  sessionPresentationsAtPath(source, workspace.hostId, workspace.path)
  expect(cost.directoryPasses).toBe(1)
  const next = measured([...members, { ...outside[0]!, updatedAt: _tailFixtureEpoch(0, 0, 10) }, ...outside.slice(1)])
  selectors.forEach((select, i) => expect(select(next.source, scopes[i]!)).toBe(first[i]))
  expect(next.cost).toEqual({ directoryPasses: 1, filters: 0 })
})

it('mounts the production Dock with scoped Goal inputs and no repeated global scans for unrelated updates', async () => {
  const initial = measured([...members, ...outside])
  useAppStore.setState({ sessions: initial.source })
  await dom.render(<SurfaceToolDock workspace={workspace} />)
  expect(dom.container.querySelectorAll('.workspace-agent-list-item')).toHaveLength(2)
  expect(initial.cost).toEqual({ directoryPasses: 1, filters: 0 })
  expect(observed.goals.length).toBeGreaterThan(0)
  expect(observed.goals.every(input => ids(input).join() === ids(members).join())).toBe(true)
  const original = observed.goals.at(-1)
  for (let update = 0; update < 20; update++) await act(async () => useAppStore.setState(state => ({
    agentNames: { ...state.agentNames, 'unrelated-0': `Other ${update}` },
    timelines: { ...state.timelines, 'unrelated-0': { agentSessionId: 'unrelated-0', revision: update, items: [] } }
  })))
  expect(initial.cost).toEqual({ directoryPasses: 1, filters: 0 })
  const next = measured([...members, { ...outside[0]!, latestOutputBytes: 100 }, ...outside.slice(1)])
  await act(async () => useAppStore.setState({ sessions: next.source }))
  expect(next.cost).toEqual({ directoryPasses: 1, filters: 0 })
  expect(observed.goals.every(input => input === original)).toBe(true)
  const changed = { ...members[0]!, status: { state: 'waiting' as const, source: 'native-hook' as const, observedAt: _tailFixtureEpoch(0, 0, 1) },
    pendingInteraction: { id: 'related-permission', kind: 'permission' as const, agentSessionId: members[0]!.id,
      title: 'Original pending request', options: [], evidence: { source: 'native-hook' as const, observedAt: _tailFixtureEpoch(0, 0, 1) } } }
  await act(async () => useAppStore.setState({ sessions: [changed, members[1]!, ...outside] }))
  expect(dom.container.querySelector(`[data-session-id="${changed.id}"]`)?.getAttribute('data-state')).toBe('waiting')
  const goal: DemandRecord = { id: 'related-goal', title: 'Original related Goal', description: '', status: 'in_progress', priority: 'normal',
    projectId: null, projectName: null, sessionIds: [], source: 'default-topic', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
    participations: [{ id: 'original-relation', operationId: 'original-relation', hostId: changed.control.hostId,
      agentSessionId: changed.control.agentSessionId, kind: 'discussion', entryPoint: 'original-entry', recordedAt: _tailFixtureEpoch(0, 0, 1) }] }
  await act(async () => useAppStore.setState({ demands: { [goal.id]: goal } }))
  expect(dom.container.querySelector('.focus-goal__trigger')?.getAttribute('aria-label')).toBe('1 Goal')
  await act(async () => useAppStore.setState({ sessions: [{ ...changed, workspacePath: fixturePath('moved-out') }, members[1]!, ...outside] }))
  expect(dom.container.querySelectorAll('.workspace-agent-list-item')).toHaveLength(1)
  expect(dom.container.querySelector('.focus-goal__trigger')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[changed.id]).toBe('Original unsent draft')
})

it('keeps Scratch directory authority, unknown observations, aliases, ambiguity and exact Host membership', () => {
  const scratch = { ...workspace, id: '__scratch__', path: fixturePath('scratch') }
  const physical = fixturePath('relocated-home'), retained = fixturePath('retained-home')
  const topic: ScratchTopicSnapshot = { id: 'topic:one', title: 'Original Topic', directoryPath: 'topic--topic--one',
    physicalDirectoryPath: physical, confirmedDirectoryPaths: [physical, retained], topicPath: 'topic.md', summary: '', collaborators: [] }
  const source = [
    { ...composerSession('root'), workspacePath: scratch.path },
    { ...composerSession('logical'), workspacePath: `${scratch.path}/topic--topic--one` },
    { ...composerSession('physical'), workspacePath: physical },
    { ...composerSession('retained'), workspacePath: retained },
    { ...composerSession('nested'), workspacePath: `${scratch.path}/topic--topic--one/nested` },
    { ...composerSession('other-host'), hostId: 'other-host', workspacePath: physical }, ...outside
  ]
  const select = createWorkspaceAgentSessionsSelector()
  for (const topics of [undefined, null, [], [topic], [{ ...topic, readError: 'Directory observation unavailable' }],
    [topic, { ...topic, id: 'topic:two', directoryPath: 'topic--topic--two' }]]) {
    expect(ids(select(source, scratch, topics))).toEqual(ids(workspaceAgentSessions(source, scratch, topics)))
  }
  const windows = { ...scratch, path: String.raw`C:\original\scratch` }
  const windowsSource = [
    { ...composerSession('windows-topic'), workspacePath: `${windows.path}\\topic--topic--one` },
    { ...composerSession('windows-sibling'), workspacePath: String.raw`C:\original\topics\topic--topic--one` }, ...outside
  ]
  expect(ids(select(windowsSource, windows))).toEqual(ids(workspaceAgentSessions(windowsSource, windows)))
  const next = measured([...source, { ...composerSession('entered'), workspacePath: physical }])
  expect(ids(select(next.source, scratch, [topic]))).toEqual(['entered', 'physical', 'retained', 'root'])
  expect(next.cost).toEqual({ directoryPasses: 1, filters: 0 })
})
