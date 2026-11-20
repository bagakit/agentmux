import { getAmuxProtocolTemplate, renderAmuxProtocol } from '@agentmux/core/amux-protocol'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { NOTES_WORKSPACE_ID } from './notes-library.js'
import type { ProjectWorkspace } from './workspace-projects.js'
type ProjectConfiguration = { workspaces: readonly ProjectWorkspace[]; hosts: readonly { id: string }[] }
import { projectWorkspaces } from './workspace-projects.js'

export type GoalProjectContext = {
  id: string
  name: string
  hostId: string
  repoPath: string
  workspaceId: string
  path: string
  branch?: string
}

/** Project owns repository identity; Workspace owns the actual working directory. */
export function goalProjectContext(config: ProjectConfiguration | null, projectId: string | null | undefined, preferredWorkspaceId?: string | null): GoalProjectContext | null {
  if (!config || !projectId) return null
  const workspaces = config.workspaces.filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID && workspace.id !== NOTES_WORKSPACE_ID)
  const project = projectWorkspaces(workspaces).find(candidate => candidate.id === projectId)
  if (!project || !project.name.trim() || !project.repoPath.trim() ||
    config.hosts.filter(host => host.id === project.hostId).length !== 1 ||
    project.workspaces.some(workspace => workspaces.filter(candidate => candidate.id === workspace.id).length !== 1)) return null
  const workspace = project.workspaces.find(candidate => candidate.id === preferredWorkspaceId) ??
    project.workspaces.find(candidate => candidate.id === project.preferredWorkspaceId)
  if (!workspace?.path.trim()) return null
  return {
    id: project.id, name: project.name, hostId: project.hostId, repoPath: project.repoPath,
    workspaceId: workspace.id, path: workspace.path,
    ...('branch' in workspace && typeof workspace.branch === 'string' && workspace.branch ? { branch: workspace.branch } : {})
  }
}

export function goalProjectContextText(context: GoalProjectContext | null, assignedProjectId?: string | null): string {
  if (!context) return assignedProjectId
    ? renderAmuxProtocol('goal-task', 'project-unavailable', { id: assignedProjectId })
    : getAmuxProtocolTemplate('goal-task', 'project-unassigned')
  return renderAmuxProtocol('goal-task', 'project', {
    name: context.name, id: context.id, host: context.hostId, repository: context.repoPath,
    workspace: context.workspaceId, directory: context.path,
    branch: context.branch ? renderAmuxProtocol('goal-task', 'project-branch', { branch: context.branch }) + '\n' : ''
  })
}
