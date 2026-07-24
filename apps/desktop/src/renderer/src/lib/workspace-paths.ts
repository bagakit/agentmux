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
