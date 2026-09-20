/** Only an explicit, configured Region Workspace grants durable Browser capabilities. */
export function verifiedBrowserWorkspace(workspaces: readonly { id: string }[], requested: unknown): string | null {
  return typeof requested === 'string' && workspaces.some(workspace => workspace.id === requested)
    ? requested : null
}
