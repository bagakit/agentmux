import { isScratchWorkspaceId, type AppConfig } from '../../../shared/contracts'
import { projectWorkspaces } from './workspace-projects'

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
export function goalProjectContext(config: AppConfig | null, projectId: string | null | undefined, preferredWorkspaceId?: string | null): GoalProjectContext | null {
  if (!config || !projectId) return null
  const workspaces = config.workspaces.filter(workspace => !isScratchWorkspaceId(workspace.id))
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
    ...(workspace.branch ? { branch: workspace.branch } : {})
  }
}

export function goalProjectContextText(context: GoalProjectContext | null, assignedProjectId?: string | null): string {
  if (!context) return [
    assignedProjectId ? `Assigned Project ID: ${assignedProjectId}` : 'Project: unassigned',
    'Registered project and workspace context is unavailable. Do not infer a project, path or home from the PMO working directory.'
  ].join('\n')
  return [
    `Project: ${context.name}`,
    `Project ID: ${context.id}`,
    `Host: ${context.hostId}`,
    `Repository root: ${context.repoPath}`,
    `Workspace ID: ${context.workspaceId}`,
    `Workspace path: ${context.path}`,
    ...(context.branch ? [`Branch: ${context.branch}`] : []),
    'These are the project paths for this request. The PMO working directory is separate; do not substitute it or assume a host home.'
  ].join('\n')
}
