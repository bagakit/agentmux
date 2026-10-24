import { isScratchWorkspaceId, type WorkspaceRecord } from '../../../shared/contracts'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import { projectWorkspaces, workspaceProjectId, type WorkspaceProject as HostWorkspaceProject } from '@agentmux/host/workspace-projects'
export { projectWorkspaces, workspaceProjectId } from '@agentmux/host/workspace-projects'

export type WorkspaceProject = HostWorkspaceProject<WorkspaceRecord>

/** Remove every registered Workspace that makes up one Project Rail view. */
export function removeProjectWorkspaces(
  workspaces: readonly WorkspaceRecord[],
  project: Pick<WorkspaceProject, 'id' | 'workspaces'>
): WorkspaceRecord[] {
  const removedIds = new Set(project.workspaces.map((workspace) => workspace.id))
  return workspaces.filter((workspace) => !removedIds.has(workspace.id))
}

export function projectRailNavigation(workspaces: readonly WorkspaceRecord[]): {
  scratch: WorkspaceRecord | null
  projects: WorkspaceProject[]
} {
  return {
    scratch: workspaces.find((workspace) => isScratchWorkspaceId(workspace.id)) ?? null,
    projects: projectWorkspaces(
      workspaces.filter((workspace) => !isScratchWorkspaceId(workspace.id) && workspace.id !== NOTES_WORKSPACE_ID)
    )
  }
}

export { projectRailTree, PROJECT_RAIL_MAX_DEPTH, railGroupAddress, projectGroupKey } from '@agentmux/client-ui/project-rail-tree'
export type ProjectRailNode = import('@agentmux/client-ui/project-rail-tree').ProjectRailNode<WorkspaceProject>
export type ProjectRailGroup = import('@agentmux/client-ui/project-rail-tree').ProjectRailGroup<WorkspaceProject>

export function defaultWorktreePath(repoPath: string, branch: string): string {
  const separator = repoPath.includes('\\') && !repoPath.includes('/') ? '\\' : '/'
  const root = repoPath.replace(/[\\/]+$/, '')
  const segment = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
  // The worktree belongs to this project, so it lives INSIDE it as `<repo>/.worktrees/<segment>`.
  // A separator before `.worktrees` is what keeps it there — without it the path collapses into a
  // sibling `<repo>.worktrees/<segment>`, which the project's .gitignore, moves, and file tree miss.
  return `${root}${separator}.worktrees${separator}${segment}`
}
