import type { TreeNode } from './file-explorer-types'

export type FileExplorerRowProjection = {
  getVisibleCount: () => number
  getVisibleSlice: (startIndex: number, endIndex: number) => TreeNode[]
  getRowAtIndex: (index: number) => TreeNode | null
  getRowByPath: (path: string) => TreeNode | null
  getIndexByPath: (path: string) => number | null
  hasPath: (path: string) => boolean
  getOrderedPaths: () => string[]
  getRowsByPaths: (paths: Set<string>) => TreeNode[]
  countVisiblePaths: (paths: Set<string>) => number
  getParentIndex: (index: number) => number | null
  getFirstChildIndex: (index: number) => number | null
}

export function createFileExplorerRowProjection(
  visibleFlatRows: TreeNode[]
): FileExplorerRowProjection {
  const rowsByPath = new Map(visibleFlatRows.map((row) => [row.path, row]))
  let indexByPath: Map<string, number> | null = null
  const getIndexMap = (): Map<string, number> => {
    if (indexByPath) return indexByPath
    indexByPath = new Map(visibleFlatRows.map((row, index) => [row.path, index]))
    return indexByPath
  }

  return {
    getVisibleCount: () => visibleFlatRows.length,
    getVisibleSlice: (startIndex, endIndex) => visibleFlatRows.slice(startIndex, endIndex + 1),
    getRowAtIndex: (index) => visibleFlatRows[index] ?? null,
    getRowByPath: (path) => rowsByPath.get(path) ?? null,
    getIndexByPath: (path) => getIndexMap().get(path) ?? null,
    hasPath: (path) => rowsByPath.has(path),
    getOrderedPaths: () => visibleFlatRows.map((row) => row.path),
    getRowsByPaths: (paths) => {
      const indexes = [...paths].flatMap((path) => {
        const index = getIndexMap().get(path)
        return index === undefined ? [] : [index]
      })
      indexes.sort((a, b) => a - b)
      return indexes
        .map((index) => visibleFlatRows[index])
        .filter((row): row is TreeNode => row !== undefined)
    },
    countVisiblePaths: (paths) => [...paths].filter((path) => rowsByPath.has(path)).length,
    getParentIndex: (index) => getParentIndex(visibleFlatRows, index),
    getFirstChildIndex: (index) => getFirstChildIndex(visibleFlatRows, index)
  }
}

function getParentIndex(rows: readonly TreeNode[], index: number): number | null {
  const current = rows[index]
  if (!current || current.depth <= 0) return null
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const node = rows[candidate]
    if (node && node.depth < current.depth) return candidate
  }
  return null
}

function getFirstChildIndex(rows: readonly TreeNode[], index: number): number | null {
  const current = rows[index]
  if (!current?.isDirectory) return null
  const next = rows[index + 1]
  return next?.depth === current.depth + 1 ? index + 1 : null
}
