import type { AgentMuxDesktopSpaceSelection } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { originalTopicAddress, topicSpatialAddress } from '../../../shared/space-addresses'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { collaborationSubjectKey, type CollaborationArea } from './agent-collaboration'
import { createWorkspaceAgentListSelector, type WorkspaceAgentExecutionResolver, type WorkspaceAgentScopeState, type WorkspaceAgentList, type WorkspaceAgentSources } from './workspace-agent-scope'
import { projectRailNavigation, projectRailTree, workspaceProjectId } from './workspace-projects'
import { categorySpaceIconTarget, folderSpaceIconTarget, topicSpaceIconTarget } from './space-object-appearance'
import { scratchTopicsForConfig, scratchTopicKind } from './scratch-topic-snapshots'

export type CollaborationAreaRequest = { workspaceId: string; choice: AgentMuxDesktopSpaceSelection | null }
export type CollaborationAreas = { areas: readonly CollaborationArea[]; current: readonly string[]; issue: string | null; title: string }

function areaMembers(lists: readonly WorkspaceAgentList[]) {
  const affiliations = new Map<string, WorkspaceAgentList['members'][number]>()
  for (const list of lists) for (const member of list.members) {
    const id = collaborationSubjectKey(member.subject), old = affiliations.get(id)
    if (!old || old.basis === 'workspace' || member.basis === 'spatial') affiliations.set(id, member)
  }
  return { members: [...affiliations.keys()], affiliations }
}

/** Only combines original list owners. Geometry and message activity are not membership. */
export function createCollaborationAreasSelector(resolve: WorkspaceAgentExecutionResolver) {
  const selectors = new Map<string, ReturnType<typeof createWorkspaceAgentListSelector>>()
  let inputs: readonly unknown[] = [], previous: CollaborationAreas
  return (state: WorkspaceAgentScopeState, request?: CollaborationAreaRequest, sources?: WorkspaceAgentSources): CollaborationAreas => {
    const next = [state.config, state.sessions, state.tabs, state.layouts, state.spaceZoneBindings, state.scratchTopicSnapshots,
      state.topicCategories, state.projectGroups, state.spatialRequests, request, sources]
    if (previous && next.every((input, at) => input === inputs[at])) return previous
    inputs = next
    const used = new Set<string>(), areas: CollaborationArea[] = []
    const list = (key: string, workspace: WorkspaceRecord, choice: AgentMuxDesktopSpaceSelection | null) => {
      used.add(key)
      let select = selectors.get(key)
      if (!select) { select = createWorkspaceAgentListSelector(resolve); selectors.set(key, select) }
      return select({ ...state, workbenchSpaceSelection: choice }, workspace, state.sessions, sources)
    }
    const { scratch, projects } = projectRailNavigation(state.config?.workspaces ?? [])
    const parents = new Map(projectRailTree(projects).flatMap(group => group.nodes.map(node => [node.project.id, node.parentId] as const)))
    for (const project of projects) {
      const lists = project.workspaces.map(workspace => list('workspace:' + workspace.id, workspace, null))
      areas.push({ id: project.id, name: project.name, kind: 'project', parentId: parents.get(project.id) ?? null, iconTarget: folderSpaceIconTarget(project),
        workspaceId: project.preferredWorkspaceId, hostId: project.hostId, ...areaMembers(lists),
        issue: [...new Set(lists.flatMap(value => value.issue ? [value.issue] : []))].join(' ') || null })
    }
    let selected: ReturnType<typeof list> | undefined, current: string[] = [], issue: string | null = null
    const workspace = state.config?.workspaces.find(value => value.id === request?.workspaceId)
    const category = request?.choice && !request.choice.topicId && !request.choice.zoneId ? state.topicCategories?.find(value => value.spaceId === request.choice?.spaceId) : undefined
    if (workspace && request) {
      selected = list('current:' + workspace.id, workspace, request.choice)
      issue = category ? null : selected.issue
      if (workspace.id !== SCRATCH_WORKSPACE_ID && (!request.choice?.spaceId || request.choice.spaceId === workspaceProjectId(workspace)) && !request.choice?.topicId) current = [workspaceProjectId(workspace)]
    }
    if (scratch) {
      for (const category of state.topicCategories ?? []) if (category.hostId === scratch.hostId) {
        areas.push({ id: category.spaceId, name: category.title, kind: 'category', iconTarget: categorySpaceIconTarget(category),
          workspaceId: scratch.id, hostId: category.hostId, members: [], issue: category.readError ?? null })
      }
      const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)
      const byTopic = new Map(topics?.map(topic => [topic.id, topic]))
      const ids = new Set([...byTopic.keys(), ...Object.values(state.spaceZoneBindings).flatMap(binding => binding.workspaceId === scratch.id && binding.topicId ? [binding.topicId] : [])])
      for (const id of ids) {
        const topic = byTopic.get(id), bindings = Object.entries(state.spaceZoneBindings).filter(([, binding]) => binding.workspaceId === scratch.id && binding.topicId === id)
        const source = topic ? originalTopicAddress(scratch, topic, state.spaceZoneBindings) : bindings.length === 1 ? { spaceId: bindings[0]![1].spaceId, zoneId: bindings[0]![0] } : null
        const display = topic ? topicSpatialAddress(state.config, topic, state.spaceZoneBindings, state.topicCategories) : source
        // A missing address stays an explicitly unresolved object, never the Scratch roster.
        const choice: AgentMuxDesktopSpaceSelection = { workspaceId: scratch.id, topicId: id, spaceId: display?.spaceId ?? null, zoneId: source?.zoneId ?? null, tabId: null, regionId: null, groupId: null }
        const value = list('topic:' + id, scratch, choice)
        const kind = source && state.spaceZoneBindings[source.zoneId]?.contentKind || scratchTopicKind(id, topics)
        const iconTarget = topic ? topicSpaceIconTarget(scratch, topic, state.spaceZoneBindings) : null
        const area: CollaborationArea = { id: value.key, name: value.title, kind: kind === 'unknown' ? 'unplaced' : kind,
          ...(kind === 'topic' && areas.some(area => area.kind === 'category' && area.id === display?.spaceId) ? { parentId: display!.spaceId } : {}),
          ...(iconTarget ? { iconTarget } : {}), workspaceId: scratch.id, hostId: scratch.hostId,
          ...areaMembers([value]), issue: value.issue }
        areas.push(area)
        if (selected?.key === value.key) current.push(area.id)
        else if (request?.choice && !request.choice.topicId && !request.choice.zoneId && display?.spaceId === request.choice.spaceId) current.push(area.id)
      }
      const placed = new Set(areas.flatMap(area => area.members))
      const total = list('scratch-total', scratch, null)
      const remaining = total.members.map(member => collaborationSubjectKey(member.subject)).filter(id => !placed.has(id))
      if (remaining.length) areas.push({ id: total.key, name: scratch.name, kind: 'unplaced', members: remaining, issue: total.issue })
      if (request?.workspaceId === scratch.id && !request.choice?.topicId && !request.choice?.zoneId && !request.choice?.spaceId) current = areas.filter(area => area.kind !== 'project').map(area => area.id)
      else if (request && selected && !current.length && !category) {
        const choice = request.choice
        // Exact root container selection is a valid Scratch overview.
        const root = !choice?.topicId && choice?.spaceId === workspaceProjectId(scratch)
        if (root) current = areas.filter(area => area.kind !== 'project').map(area => area.id)
        else {
          const object = Boolean(choice?.topicId)
          const area: CollaborationArea = { id: 'unconfirmed:' + JSON.stringify(request), name: selected.title, kind: 'unplaced', members: object ? selected.members.map(member => collaborationSubjectKey(member.subject)) : [],
            issue: selected.issue ?? 'The original area is unconfirmed. Its exact reference is retained; refresh the original spatial facts.' }
          areas.push(area); current = [area.id]
        }
      }
    }
    if (request && !workspace) issue = 'The original Workspace is unavailable. Its exact reference is retained; refresh the original spatial facts.'
    for (const key of selectors.keys()) if (!used.has(key)) selectors.delete(key)
    if (request && workspace && !scratch && !current.length && !category) issue ??= 'The original area is unconfirmed. Its exact reference is retained; refresh the original spatial facts.'
    // An execution directory may explain an otherwise unplaced Session. It must
    // never create an extra location beside an original binding or collaborator.
    const placed = new Set(areas.filter(area => area.kind !== 'unplaced').flatMap(area => [...area.affiliations ?? []].flatMap(([id, member]) => member.basis !== 'workspace' ? [id] : [])))
    const resolved = areas.map(area => {
      const members = area.members.filter(id => !placed.has(id) || area.kind !== 'unplaced' && area.affiliations?.get(id)?.basis !== 'workspace')
      const retained = new Set(members)
      return members.length === area.members.length ? area : { ...area, members, ...(area.affiliations ? { affiliations: new Map([...area.affiliations].filter(([id]) => retained.has(id))) } : {}) }
    })
    previous = { areas: resolved, current, issue, title: category?.title ?? selected?.title ?? workspace?.name ?? 'Space' }
    return previous
  }
}
