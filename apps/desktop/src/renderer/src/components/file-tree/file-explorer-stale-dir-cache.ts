import type { DirCache } from './file-explorer-types'

export function collectStaleDirCachePaths(
  cache: Record<string, DirCache>,
  rootPath: string,
  expanded: ReadonlySet<string>
): string[] {
  return Object.keys(cache).filter((dirPath) => dirPath !== rootPath && !expanded.has(dirPath))
}

export type ExpandedDirLoadDecision = 'skip' | 'load' | 'reload'

export function decideExpandedDirLoad(
  cached: DirCache | undefined,
  stale: boolean
): ExpandedDirLoadDecision {
  if (cached?.loading) return 'skip'
  if (!cached?.children.length) return 'load'
  return stale ? 'reload' : 'skip'
}
