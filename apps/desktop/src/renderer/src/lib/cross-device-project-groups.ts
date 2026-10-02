import type { AgentMuxProjectGroupFact } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { projectWorkspaces, type WorkspaceProject } from './workspace-projects'

export function projectGroupsFor(groups: readonly AgentMuxProjectGroupFact[], projectId: string) {
  return groups.filter(group => group.projectIds.includes(projectId))
}

/** Reject only an invalid organization request; original resources and Runs stay usable. */
export function validateProjectGroup(group: AgentMuxProjectGroupFact, groups: readonly AgentMuxProjectGroupFact[], workspaces: readonly WorkspaceRecord[]): AgentMuxProjectGroupFact {
  if (!group.groupId || !group.name.trim()) throw new Error('Give the project group a name.')
  if (group.projectIds.length < 2 || new Set(group.projectIds).size !== group.projectIds.length) throw new Error('Choose at least two distinct Projects.')
  const existing = groups.find(value => value.groupId === group.groupId)
  const renaming = existing && existing.projectIds.length === group.projectIds.length && existing.projectIds.every((id, index) => id === group.projectIds[index])
  if (!renaming) {
    const projects = new Map(projectWorkspaces(workspaces).map(project => [project.id, project]))
    const members = group.projectIds.map(id => projects.get(id))
    if (members.some((member, index) => !member && !existing?.projectIds.includes(group.projectIds[index]!))) throw new Error('A selected Project registration changed. Review the current projects; your selection is retained.')
  }
  return { ...group, name: group.name.trim(), projectIds: [...group.projectIds] }
}

/** Original Project reference remains useful even while its registration is unavailable. */
export function projectGroupMember(id: string, projects: readonly WorkspaceProject[]) {
  const project = projects.find(project => project.id === id)
  if (project) return { project, name: project.name, hostId: project.hostId, path: project.repoPath }
  let identity: unknown
  try { identity = JSON.parse(id) } catch { /* The opaque reference is retained verbatim. */ }
  const hostId = Array.isArray(identity) && typeof identity[0] === 'string' ? identity[0] : null
  const path = Array.isArray(identity) && typeof identity[1] === 'string' ? identity[1] : id
  return { project: undefined, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, hostId, path }
}
