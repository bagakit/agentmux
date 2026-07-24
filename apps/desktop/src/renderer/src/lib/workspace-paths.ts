export function getRevealAncestorPaths(filePath: string): string[] {
  const segments = filePath.split('/').filter(Boolean)
  const ancestors: string[] = []
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/'))
  }
  return ancestors
}

export function isPathWithinSubtree(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

export function remapPathWithinSubtree(path: string, oldRoot: string, nextRoot: string): string {
  return isPathWithinSubtree(path, oldRoot)
    ? `${nextRoot}${path.slice(oldRoot.length)}`
    : path
}

export function joinWorkspacePath(root: string, relativePath: string): string {
  if (!relativePath) return root
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const normalizedRoot = root.replace(/[\\/]+$/, '')
  const normalizedRelative = relativePath.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, '')
  return `${normalizedRoot}${separator}${normalizedRelative}`
}
