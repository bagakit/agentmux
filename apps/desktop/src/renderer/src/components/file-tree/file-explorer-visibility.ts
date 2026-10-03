import { getRevealAncestorPaths } from '../../lib/workspace-paths'
import type { TreeNode } from './file-explorer-types'

/** Presentation only: cached entries and selection remain owned by their original tree. */
export function projectFileExplorerRows(
  rows: readonly TreeNode[],
  showHidden: boolean,
  showIgnored: boolean,
  query: string,
  retainedPaths: readonly (string | null | undefined)[]
): readonly TreeNode[] {
  const normalized = query.trim().toLowerCase()
  if (showHidden && showIgnored && !normalized) return rows

  const retained = new Set<string>()
  for (const path of retainedPaths) {
    if (path === null || path === undefined) continue
    retained.add(path)
    for (const ancestor of getRevealAncestorPaths(path)) retained.add(ancestor)
  }
  const hiddenDirectories = new Set<string>()
  return rows.filter(node => {
    const hidden = (!showHidden && node.name.startsWith('.')) || (!showIgnored && node.ignored === true)
      || getRevealAncestorPaths(node.path).some(path => hiddenDirectories.has(path))
    if (hidden && node.isDirectory) hiddenDirectories.add(node.path)
    return retained.has(node.path) || (!hidden && (!normalized
      || node.name.toLowerCase().includes(normalized) || node.path.toLowerCase().includes(normalized)))
  })
}
