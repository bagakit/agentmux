import { directoryIdentity } from './mote-model.js'
import { NOTES_WORKSPACE_ID } from './notes-library.js'

export type ProjectWorkspace = { id: string; name: string; hostId: string; path: string; repoPath?: string; kind?: string; closeout?: unknown }
export type WorkspaceProject<T extends ProjectWorkspace = ProjectWorkspace> = {
  id: string; name: string; hostId: string; repoPath: string; workspaces: T[]; preferredWorkspaceId: string
}
export function workspaceProjectId(workspace: ProjectWorkspace): string { return directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path) }

/** Original registered resource grouping, shared by Host observation and Desktop presentation. */
export function projectWorkspaces<T extends ProjectWorkspace>(workspaces: readonly T[]): WorkspaceProject<T>[] {
  const projects = new Map<string, WorkspaceProject<T>>()
  for (const workspace of workspaces) {
    if (workspace.closeout || workspace.id === NOTES_WORKSPACE_ID) continue
    const id = workspaceProjectId(workspace), existing = projects.get(id)
    if (existing) {
      existing.workspaces.push(workspace)
      if (workspace.kind === 'folder' && workspace.path === existing.repoPath) { existing.preferredWorkspaceId = workspace.id; existing.name = workspace.name }
      continue
    }
    const repoPath = workspace.repoPath ?? workspace.path
    projects.set(id, { id, name: workspace.kind === 'folder' ? workspace.name : repoPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? repoPath,
      hostId: workspace.hostId, repoPath, workspaces: [workspace], preferredWorkspaceId: workspace.id })
  }
  return [...projects.values()]
}
