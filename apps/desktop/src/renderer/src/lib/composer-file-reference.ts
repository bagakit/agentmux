/**
 * Append file references to a composer draft.
 *
 * A reference is a path the Agent reads for itself — AgentMux never inlines file contents into the
 * prompt. Paths inside the workspace are written relative to it, because that is what the Agent's own
 * working directory makes meaningful; anything outside stays absolute so it still resolves.
 */
export function workspaceRelativePath(path: string, workspacePath: string | undefined): string {
  if (!workspacePath) return path
  const root = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

export function appendFileReferences(
  draft: string,
  paths: readonly string[],
  workspacePath?: string
): string {
  if (paths.length === 0) return draft
  const references = paths.map((path) => `@${workspaceRelativePath(path, workspacePath)}`).join(' ')
  // Keep exactly one space between what the user typed and the reference, and leave a trailing space
  // so they can keep typing without fixing up spacing.
  const separator = draft && !draft.endsWith(' ') ? ' ' : ''
  return `${draft}${separator}${references} `
}
