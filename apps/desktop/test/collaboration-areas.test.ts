// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import type { AgentMuxDesktopSpaceSelection } from '@agentmux/core/control'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { useAppStore } from '../src/renderer/src/store'
import { createCollaborationAreasSelector } from '../src/renderer/src/lib/collaboration-areas'
import { createWorkspaceAgentListSelector, workspaceAgentListMembers } from '../src/renderer/src/lib/workspace-agent-scope'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { originalTopicAddress, topicSpatialAddress, workspaceZoneId } from '../src/shared/space-addresses'
import { collaborationSubjectKey } from '../src/renderer/src/lib/agent-collaboration'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { customAgent, customMoteId, moteAgent, moteConfig, moteTopics, ordinaryTopicId, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

const resolve = () => ({ hostId: 'local' })
const key = (id: string, hostId = 'local') => collaborationSubjectKey({ hostId, agentSessionId: id })
function choice(topicId: string, workspaceId = scratchWorkspace.id): AgentMuxDesktopSpaceSelection {
  const state = useAppStore.getState(), topic = moteTopics.find(value => value.id === topicId)!
  const address = topicSpatialAddress(state.config, topic, state.spaceZoneBindings, state.topicCategories)!
  return { workspaceId, topicId, ...address, tabId: null, regionId: null, groupId: null }
}
beforeEach(() => {
  seedMoteWorkface()
  useAppStore.setState({ spaceZoneBindings: {}, spatialRequests: {}, topicCategories: [], projectGroups: [], workbenchSpaceSelection: null })
})

it('uses the original Mote membership across display Workspaces and includes visible members in reorder validation', () => {
  const state = useAppStore.getState(), project = moteConfig.workspaces.find(value => value.id === 'project')!
  const selection = choice(customMoteId, project.id), facts = { ...state, workbenchSpaceSelection: selection }
  const original = createWorkspaceAgentListSelector(resolve)(facts, project)
  expect(original.issue).toBeNull(); expect(original.sessions.map(value => value.id)).toEqual([customAgent.id])
  expect(workspaceAgentListMembers(facts, project, resolve).map(value => value.id)).toContain(customAgent.id)
  const graph = createCollaborationAreasSelector(resolve)(facts, { workspaceId: project.id, choice: selection })
  expect(graph.current).toEqual([original.key]); expect(graph.issue).toBeNull()
  expect(graph.areas.find(value => value.id === graph.current[0])?.members).toEqual([key(customAgent.id)])
})

it('preserves an exact unconfirmed selection issue instead of silently presenting its healthy canonical area', () => {
  const selection = { ...choice(customMoteId), spaceId: 'unconfirmed-mote-space' }
  const graph = createCollaborationAreasSelector(resolve)(useAppStore.getState(), { workspaceId: scratchWorkspace.id, choice: selection })
  expect(graph.issue).toContain('unconfirmed')
  expect(graph.current).toHaveLength(1)
  expect(graph.areas.find(value => value.id === graph.current[0])?.members).toEqual([key(customAgent.id)])
  const missing = createCollaborationAreasSelector(resolve)(useAppStore.getState(), { workspaceId: 'missing-workspace', choice: selection })
  expect(missing.issue).toContain('unavailable'); expect(missing.current).toEqual([])
})

it('keeps original Host ownership when a collaborator SID also has a presentation on another Host', () => {
  const state = useAppStore.getState(), local = moteAgent('shared-collaborator', null)
  const remote = { ...local, id: 'remote-presentation', hostId: 'remote', control: { ...local.control, hostId: 'remote' } }
  const topics = moteTopics.map(topic => topic.id === customMoteId ? { ...topic, collaborators: [{ fileName: 'original-collaborator.md', sessionId: local.control.agentSessionId, providerId: local.providerId }] } : topic)
  const facts = { ...state, sessions: [...state.sessions, remote, local], scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
    [scratchWorkspace.id]: { ...state.scratchTopicSnapshots[scratchWorkspace.id]!, topics } } }
  const graph = createCollaborationAreasSelector(resolve)(facts, { workspaceId: scratchWorkspace.id, choice: choice(customMoteId) })
  const members = graph.areas.find(value => value.id === graph.current[0])!.members
  expect(members).toContain(key(local.control.agentSessionId)); expect(members).not.toContain(key(local.control.agentSessionId, 'remote'))
  expect(members.filter(id => id === key(local.control.agentSessionId))).toHaveLength(1)
})

it('uses original project Region ownership even when execution cwd belongs elsewhere', () => {
  const state = useAppStore.getState(), project = moteConfig.workspaces.find(value => value.id === 'project')!
  const session = { ...moteAgent('bound-away-from-cwd', customMoteId), workspacePath: fixturePath('unrelated-resource') }
  const tab = createWorkbenchTab('bound-project-tab', { kind: 'agent', phase: 'attached', workspaceId: project.id, regionId: 'bound-project-region', sessionId: session.id })
  const facts = { ...state, sessions: [...state.sessions, session], tabs: { ...state.tabs, [tab.id]: tab }, layouts: { ...state.layouts, [project.id]: createWorkspaceLayout('project-group', [tab.id]) } }
  const graph = createCollaborationAreasSelector(resolve)(facts)
  expect(graph.areas.find(value => value.id === workspaceProjectId(project))!.members).toContain(key(session.id))
  const unconfirmed = createCollaborationAreasSelector(() => null)(facts)
  expect(unconfirmed.areas.find(value => value.id === workspaceProjectId(project))!.issue).toContain('unconfirmed')
  expect(unconfirmed.areas.find(value => value.id === workspaceProjectId(project))!.members).not.toContain(key(session.id))
  const projectId = workspaceProjectId(project), projectZone = workspaceZoneId(projectId, project.id), mote = originalTopicAddress(scratchWorkspace, moteTopics.find(value => value.id === customMoteId)!, {})!
  const originalBinding = { spaceId: mote.spaceId, workspaceId: project.id, topicId: customMoteId, relations: { [projectId]: true } }
  const projectChoice: AgentMuxDesktopSpaceSelection = { workspaceId: project.id, spaceId: projectId, zoneId: projectZone, topicId: null, tabId: tab.id, regionId: 'bound-project-region', groupId: 'project-group' }
  const linked = { ...facts, spaceZoneBindings: { [projectZone]: originalBinding } }
  const select = createCollaborationAreasSelector(resolve), projected = select(linked, { workspaceId: project.id, choice: projectChoice })
  expect(projected.current).toEqual([projectId]); expect(projected.issue).toBeNull()
  expect(projected.areas.find(value => value.id === projectId)!.members).toContain(key(session.id))
  expect(projected.areas.find(value => value.id === projectId)!.members).not.toContain(key(customAgent.id))
  const unlinked = select({ ...linked, spaceZoneBindings: { [projectZone]: { ...originalBinding, relations: { [projectId]: false } } } }, { workspaceId: project.id, choice: projectChoice })
  expect(unlinked.areas.find(value => value.id === projectId)!.members).not.toContain(key(session.id))
  expect(unlinked.areas.find(value => value.id === projectId)!.members).not.toContain(key(customAgent.id))
  expect(unlinked.areas.find(value => value.name === moteTopics.find(value => value.id === customMoteId)!.title)!.members).toContain(key(session.id))
})

it('keeps Topic category Space and original Zone distinct and groups a category without broadening to other objects', () => {
  const state = useAppStore.getState(), topic = moteTopics.find(value => value.id === ordinaryTopicId)!, source = originalTopicAddress(scratchWorkspace, topic, {})!
  const category = { categoryId: 'engineering', spaceId: 'category-engineering', title: 'Engineering', hostId: 'local', directoryPath: fixturePath('categories/engineering'), revision: null }
  const facts = { ...state, topicCategories: [category], spaceZoneBindings: { [source.zoneId]: { spaceId: source.spaceId, workspaceId: scratchWorkspace.id,
    topicId: topic.id, directoryPath: topic.directoryPath, contentKind: 'topic' as const, relations: { [category.spaceId]: true } } } }
  const selection = { ...choice(ordinaryTopicId), spaceId: category.spaceId }
  const select = createCollaborationAreasSelector(resolve), graph = select(facts, { workspaceId: scratchWorkspace.id, choice: selection })
  expect(graph.issue).toBeNull(); expect(graph.current).toHaveLength(1)
  expect(graph.areas.find(value => value.id === graph.current[0])?.kind).toBe('topic')
  const categoryGraph = select(facts, { workspaceId: scratchWorkspace.id, choice: { ...selection, topicId: null, zoneId: null } })
  expect(categoryGraph.title).toBe(category.title); expect(categoryGraph.current).toEqual(graph.current)
  const wrong = select(facts, { workspaceId: scratchWorkspace.id, choice: { ...selection, zoneId: workspaceZoneId(category.spaceId, 'wrong-zone') } })
  expect(wrong.issue).toContain('unconfirmed')
})

it('keeps the captured request independent from background selection and coalesces project worktrees by original identity', () => {
  const state = useAppStore.getState(), project = moteConfig.workspaces.find(value => value.id === 'project')!
  const worktree = { ...project, id: 'project-worktree', kind: 'worktree' as const, path: fixturePath('worktree'), repoPath: project.path }
  const other = { ...project, id: 'other-host-project', hostId: 'remote' }
  const facts = { ...state, config: { ...moteConfig, workspaces: [...moteConfig.workspaces, worktree, other] } }
  const request = { workspaceId: scratchWorkspace.id, choice: choice(customMoteId) }, select = createCollaborationAreasSelector(resolve)
  const initial = select(facts, request), changed = select({ ...facts, workbenchSpaceSelection: choice(ordinaryTopicId) }, request)
  expect(changed).toBe(initial)
  expect(initial.areas.filter(value => value.kind === 'project').map(value => value.id)).toEqual([workspaceProjectId(project), workspaceProjectId(other)])
  expect(initial.current).toHaveLength(1); expect(initial.areas.find(value => value.id === initial.current[0])?.members).toEqual([key(customAgent.id)])
})
