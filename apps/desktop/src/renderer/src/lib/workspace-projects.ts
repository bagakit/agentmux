import type { WorkspaceRecord } from '../../../shared/contracts'

export type WorkspaceProject = {
  id: string
  name: string
  hostId: string
  repoPath: string
  workspaces: WorkspaceRecord[]
  preferredWorkspaceId: string
}

export function workspaceProjectId(workspace: WorkspaceRecord): string {
  return JSON.stringify([workspace.hostId, workspace.repoPath ?? workspace.path])
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function projectWorkspaces(workspaces: readonly WorkspaceRecord[]): WorkspaceProject[] {
  const projects = new Map<string, WorkspaceProject>()
  for (const workspace of workspaces) {
    const id = workspaceProjectId(workspace)
    const existing = projects.get(id)
    if (existing) {
      existing.workspaces.push(workspace)
      if (workspace.kind === 'folder' && workspace.path === existing.repoPath) {
        existing.preferredWorkspaceId = workspace.id
        existing.name = workspace.name
      }
      continue
    }
    const repoPath = workspace.repoPath ?? workspace.path
    projects.set(id, {
      id,
      name: workspace.kind === 'folder' ? workspace.name : basename(repoPath),
      hostId: workspace.hostId,
      repoPath,
      workspaces: [workspace],
      preferredWorkspaceId: workspace.id
    })
  }
  return [...projects.values()]
}

export function defaultWorktreePath(repoPath: string, branch: string): string {
  const separator = repoPath.includes('\\') && !repoPath.includes('/') ? '\\' : '/'
  const root = repoPath.replace(/[\\/]+$/, '')
  const segment = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
  return `${root}.worktrees${separator}${segment}`
}
