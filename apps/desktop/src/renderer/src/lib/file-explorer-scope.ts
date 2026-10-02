/** Browser roots are display scopes within the original resource Workspace. */
export function fileExplorerContains(root: string, path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '.' || part === '..')) return false
  return root === '' || path === root || path.startsWith(root + '/')
}

export function fileExplorerRelativeRoot(workspacePath: string, directoryPath: string): string | null {
  const workspace = workspacePath.replace(/\/+$/, ''), directory = directoryPath.replace(/\/+$/, '')
  if (directory === workspace) return ''
  if (!directory.startsWith(workspace + '/')) return null
  const root = directory.slice(workspace.length + 1)
  return fileExplorerContains('', root) ? root : null
}
