// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import type { AgentMuxDesktopSpaceSelection } from '@agentmux/core/control'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { useAppStore } from '../src/renderer/src/store'
import { createCollaborationAreasSelector } from '../src/renderer/src/lib/collaboration-areas'
import { collaborationAgentPresentation } from '../src/renderer/src/lib/collaboration-map-presentation'
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

it('uses the original Mote membership across display Workspaces without granting public Project ordering membership', () => {
  const state = useAppStore.getState(), project = moteConfig.workspaces.find(value => value.id === 'project')!
  const selection = choice(customMoteId, project.id), facts = { ...state, workbenchSpaceSelection: selection }
  const original = createWorkspaceAgentListSelector(resolve)(facts, project)
  expect(original.issue).toBeNull(); expect(original.sessions.map(value => value.id)).toEqual([customAgent.id])
  expect(workspaceAgentListMembers(facts, project, resolve).map(value => value.id)).not.toContain(customAgent.id)
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
  expect(graph.areas.find(value => value.id === graph.current[0])?.parentId).toBe(category.spaceId)
  expect(graph.areas.find(value => value.id === category.spaceId)).toMatchObject({ kind: 'category', name: category.title, members: [] })
  expect(graph.areas.find(value => value.id === graph.current[0])).toMatchObject({ workspaceId: scratchWorkspace.id, hostId: scratchWorkspace.hostId,
    iconTarget: { key: source.spaceId, kind: 'topic', imageTarget: { kind: 'topic', workspaceId: scratchWorkspace.id, topicId: topic.id, objectKey: source.spaceId } } })
  expect(source.spaceId).not.toBe(category.spaceId)
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
  expect(initial.areas.filter(value => value.kind === 'project').map(value => ({ hostId: value.hostId, workspaceId: value.workspaceId, iconTarget: value.iconTarget }))).toEqual([
    { hostId: project.hostId, workspaceId: project.id, iconTarget: { key: workspaceProjectId(project), name: project.name, kind: 'folder' } },
    { hostId: other.hostId, workspaceId: other.id, iconTarget: { key: workspaceProjectId(other), name: other.name, kind: 'folder' } }
  ])
  expect(initial.current).toHaveLength(1); expect(initial.areas.find(value => value.id === initial.current[0])?.members).toEqual([key(customAgent.id)])
})

it('preserves the real project ancestry without grouping prefix siblings, other Hosts or worktrees as children', () => {
  const state = useAppStore.getState(), project = moteConfig.workspaces.find(value => value.id === 'project')!
  const child = { ...project, id: 'child', path: project.path + '/tools' }, grandchild = { ...project, id: 'grandchild', path: project.path + '/tools/deep' }
  const sibling = { ...project, id: 'prefix-sibling', path: project.path + '-preview' }, remote = { ...child, id: 'remote-child', hostId: 'remote' }
  const worktree = { ...project, id: 'worktree', kind: 'worktree' as const, path: project.path + '/.worktrees/work', repoPath: project.path }
  const graph = createCollaborationAreasSelector(resolve)({ ...state, config: { ...moteConfig, workspaces: [grandchild, sibling, worktree, remote, project, child] } })
  expect(graph.areas.filter(area => area.kind === 'project').map(area => [area.id, area.parentId])).toEqual([
    [workspaceProjectId(grandchild), workspaceProjectId(child)], [workspaceProjectId(sibling), null],
    [workspaceProjectId(project), null], [workspaceProjectId(remote), null], [workspaceProjectId(child), workspaceProjectId(project)]
  ])
  expect(graph.areas.some(area => area.id === workspaceProjectId(worktree) && area.parentId === workspaceProjectId(project))).toBe(false)
})

function retained(id: string, workspacePath: string, hostId = 'local', providerId = 'fixture'): AgentSessionHistoryDescriptor {
  return { hostId, agentSessionId: id, state: 'retired', history: { providerId, executorId: providerId, workspacePath, createdAt: 1 } }
}
const metadata = (...sources: AgentSessionHistoryDescriptor[]) => new Map(sources.map(source => [key(source.agentSessionId, source.hostId), source]))

it('associates retained exact workspaces and worktrees with the original project without live Sessions', () => {
  const state = useAppStore.getState(), project = moteConfig.workspaces.find(value => value.id === 'project')!
  const worktree = { ...project, id: 'retained-worktree', path: fixturePath('worktree'), repoPath: project.path, kind: 'worktree' as const }
  const facts = { ...state, config: { ...moteConfig, workspaces: [...moteConfig.workspaces, worktree] }, sessions: [], tabs: {}, layouts: {} }
  const originals = metadata(retained('retained-root', project.path), retained('retained-worktree', worktree.path), retained('not-a-child-guess', project.path + '/unregistered-child'))
  const select = createCollaborationAreasSelector(resolve), graph = select(facts, undefined, originals)
  const area = graph.areas.find(value => value.id === workspaceProjectId(project))!
  expect(area.members).toEqual([key('retained-root'), key('retained-worktree')])
  expect(area.affiliations?.get(key('retained-root'))).toMatchObject({ basis: 'workspace', workspacePath: project.path })
  expect(area.affiliations?.get(key('retained-worktree'))).toMatchObject({ basis: 'workspace', workspacePath: worktree.path })
  expect(graph.areas.some(value => value.members.includes(key('not-a-child-guess')))).toBe(false)
  expect(facts.sessions).toEqual([]); expect(facts.tabs).toEqual({})
  expect(select(facts, undefined, originals)).toBe(graph)
  const list = createWorkspaceAgentListSelector(resolve)(facts, project, [], originals)
  expect(list.sessions).toEqual([]); expect(list.members.map(member => member.subject.agentSessionId)).toEqual(['retained-root'])
})

it('retains original spatial and collaborator membership without live presentation or an active Run', () => {
  const state = useAppStore.getState(), topic = moteTopics.find(value => value.id === customMoteId)!
  const topics = moteTopics.map(value => value.id === customMoteId ? { ...value, collaborators: [
    { fileName: 'retained.md', sessionId: 'historical-collaborator', providerId: 'fixture' },
    { fileName: 'conflicting.md', sessionId: 'provider-conflict', providerId: 'fixture' }
  ] } : value)
  const facts = { ...state, sessions: [], scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
    [scratchWorkspace.id]: { ...state.scratchTopicSnapshots[scratchWorkspace.id]!, topics } } }
  const sources = metadata(retained(customAgent.id, fixturePath('other-execution-directory')),
    retained('historical-collaborator', fixturePath('other-execution-directory')),
    retained('provider-conflict', fixturePath('other-execution-directory'), 'local', 'different-provider'))
  const graph = createCollaborationAreasSelector(resolve)(facts, undefined, sources), area = graph.areas.find(value => value.name === topic.title)!
  expect(area.members).toEqual([key('historical-collaborator'), key(customAgent.id)])
  expect(area.affiliations?.get(key(customAgent.id))?.basis).toBe('spatial')
  expect(area.affiliations?.get(key('historical-collaborator'))?.basis).toBe('collaborator')
  expect(area.members).not.toContain(key('provider-conflict'))
  expect(area.members).not.toContain(key('historical-collaborator', 'remote'))
  expect(facts.sessions).toEqual([])
})

it('qualifies exact resource association by Host and rejects ambiguous Topic directory evidence', () => {
  const state = useAppStore.getState(), project = moteConfig.workspaces.find(value => value.id === 'project')!
  const remote = { ...project, id: 'remote', hostId: 'remote' }, physical = fixturePath('relocated-topic')
  const topics = moteTopics.map(value => value.id === ordinaryTopicId ? { ...value, physicalDirectoryPath: physical, confirmedDirectoryPaths: [physical] } : value)
  const facts = { ...state, config: { ...moteConfig, workspaces: [...moteConfig.workspaces, remote] }, sessions: [], tabs: {}, layouts: {},
    scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [scratchWorkspace.id]: { ...state.scratchTopicSnapshots[scratchWorkspace.id]!, topics } } }
  const sources = metadata(retained('same-id', project.path), retained('same-id', project.path, 'remote'), retained('topic-history', physical),
    retained('foreign-topic', physical, 'remote'))
  const select = createCollaborationAreasSelector(resolve), graph = select(facts, undefined, sources)
  expect(graph.areas.find(value => value.id === workspaceProjectId(project))!.members).toEqual([key('same-id')])
  expect(graph.areas.find(value => value.id === workspaceProjectId(remote))!.members).toEqual([key('same-id', 'remote')])
  const area = graph.areas.find(value => value.name === topics.find(value => value.id === ordinaryTopicId)!.title)!
  expect(area.members).toEqual([key('topic-history')]); expect(area.affiliations?.get(key('topic-history'))?.workspacePath).toBe(physical)
  const ambiguous = { ...facts, scratchTopicSnapshots: { ...facts.scratchTopicSnapshots, [scratchWorkspace.id]: {
    ...facts.scratchTopicSnapshots[scratchWorkspace.id]!, topics: topics.map(value => value.id === customMoteId ? { ...value, physicalDirectoryPath: physical, confirmedDirectoryPaths: [physical] } : value) } } }
  expect(select(ambiguous, undefined, sources).areas.some(value => value.members.includes(key('topic-history')))).toBe(false)
})

it('preserves all original multi-area bindings without adding an execution-directory occurrence', () => {
  const state = useAppStore.getState(), project = moteConfig.workspaces.find(value => value.id === 'project')!
  const twoTabs = Object.fromEntries(Object.entries(state.tabs).map(([id, tab]) => [id, id === 'ordinary-tab' ? {
    ...tab, regions: Object.fromEntries(Object.entries(tab.regions).map(([regionId, surface]) => [regionId, surface.kind === 'agent' ? { ...surface, sessionId: customAgent.id } : surface])) } : tab]))
  const graph = createCollaborationAreasSelector(resolve)({ ...state, sessions: [], tabs: twoTabs }, undefined, metadata(retained(customAgent.id, project.path)))
  const occurrences = graph.areas.filter(area => area.members.includes(key(customAgent.id)))
  expect(occurrences.map(area => area.name)).toEqual([moteTopics.find(value => value.id === customMoteId)!.title, moteTopics.find(value => value.id === ordinaryTopicId)!.title])
  expect(occurrences.every(area => area.affiliations?.get(key(customAgent.id))?.basis === 'spatial')).toBe(true)
  expect(graph.areas.find(area => area.id === workspaceProjectId(project))!.members).not.toContain(key(customAgent.id))
})


it('retains original Mote assets and known object Host without inventing an asset identity for an unreadable Topic', () => {
  const state = useAppStore.getState(), mote = moteTopics.find(value => value.id === customMoteId)!, address = originalTopicAddress(scratchWorkspace, mote, {})!
  const broken = moteTopics.map(topic => topic.id === ordinaryTopicId ? { ...topic, readError: 'Original Topic directory is unavailable' } : topic)
  const facts = { ...state, scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [scratchWorkspace.id]: { ...state.scratchTopicSnapshots[scratchWorkspace.id]!, topics: broken } } }
  const select = createCollaborationAreasSelector(resolve), graph = select(facts)
  expect(graph.areas.find(area => area.name === mote.title)).toMatchObject({ kind: 'mote', workspaceId: scratchWorkspace.id, hostId: scratchWorkspace.hostId,
    iconTarget: { key: address.spaceId, kind: 'mote', avatarTarget: { workspaceId: scratchWorkspace.id, topicId: mote.id, objectKey: address.spaceId } } })
  const unavailable = graph.areas.find(area => area.name === moteTopics.find(topic => topic.id === ordinaryTopicId)!.title)!
  expect(unavailable).toBeDefined(); expect(unavailable.iconTarget).toBeUndefined()
  expect(unavailable.hostId).toBe(scratchWorkspace.hostId); expect(unavailable.workspaceId).toBe(scratchWorkspace.id)
  expect(unavailable.issue).toBeTruthy(); expect(select(facts)).toBe(graph)
})

it('projects the exact Session Provider and Executor independently of names or display metadata', () => {
  const session = { ...moteAgent('identity-member', null), providerId: 'original-provider', executorId: 'configured-executor' }
  const presentation = collaborationAgentPresentation(session, 'A different display name')
  expect(presentation).toMatchObject({ name: 'A different display name', providerId: 'original-provider', executorId: 'configured-executor' })
  expect(session.label).toBe('identity-member')
})
