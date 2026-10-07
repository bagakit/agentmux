export const WORKSPACE_GIT_VIEWS = ['changes', 'history', 'branches'] as const
export type WorkspaceGitView = (typeof WORKSPACE_GIT_VIEWS)[number]

export function restoreWorkspaceGitView(value: unknown): WorkspaceGitView {
  return WORKSPACE_GIT_VIEWS.includes(value as WorkspaceGitView) ? value as WorkspaceGitView : 'changes'
}

export function restoreGitCommitDrafts(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
