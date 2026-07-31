import type { FileExplorerRowProjection } from './file-explorer-row-projection'

export type NavigationKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'

export type ResolvedNavigation =
  | { type: 'move'; targetIndex: number }
  | { type: 'toggle-expand' | 'toggle-collapse'; currentIndex: number; dirPath: string }
  | { type: 'no-op' }
  | { type: 'unhandled' }

// Standard tree navigation model: arrows move in visible tree order, Right enters
// a child, Left returns to a parent, and page/home/end preserve tree semantics.
export function resolveFileExplorerNavigationTarget(args: {
  key: NavigationKey
  currentIndex: number | null
  rowProjection: FileExplorerRowProjection
  total: number
  isExpanded: (path: string) => boolean
}): ResolvedNavigation {
  const { key, currentIndex, rowProjection, total, isExpanded } = args
  if (total === 0) return { type: 'no-op' }
  if (currentIndex === null) {
    if (key === 'ArrowDown' || key === 'End' || key === 'PageDown') {
      return { type: 'move', targetIndex: 0 }
    }
    if (key === 'ArrowUp' || key === 'Home' || key === 'PageUp') {
      return { type: 'move', targetIndex: total - 1 }
    }
    return { type: 'unhandled' }
  }

  switch (key) {
    case 'ArrowDown': return { type: 'move', targetIndex: Math.min(total - 1, currentIndex + 1) }
    case 'ArrowUp': return { type: 'move', targetIndex: Math.max(0, currentIndex - 1) }
    case 'Home': return { type: 'move', targetIndex: 0 }
    case 'End': return { type: 'move', targetIndex: total - 1 }
    case 'PageDown': return {
      type: 'move',
      targetIndex: Math.min(total - 1, currentIndex + Math.max(1, Math.floor(total / 10)))
    }
    case 'PageUp': return {
      type: 'move',
      targetIndex: Math.max(0, currentIndex - Math.max(1, Math.floor(total / 10)))
    }
    case 'ArrowRight': {
      const node = rowProjection.getRowAtIndex(currentIndex)
      if (!node?.isDirectory) return { type: 'move', targetIndex: currentIndex }
      if (!isExpanded(node.path)) {
        return { type: 'toggle-expand', currentIndex, dirPath: node.path }
      }
      return { type: 'move', targetIndex: rowProjection.getFirstChildIndex(currentIndex) ?? currentIndex }
    }
    case 'ArrowLeft': {
      const node = rowProjection.getRowAtIndex(currentIndex)
      if (!node) return { type: 'no-op' }
      if (node.isDirectory && isExpanded(node.path)) {
        return { type: 'toggle-collapse', currentIndex, dirPath: node.path }
      }
      const parentIndex = rowProjection.getParentIndex(currentIndex)
      return parentIndex === null ? { type: 'no-op' } : { type: 'move', targetIndex: parentIndex }
    }
  }
}

export function isNavigationKey(key: string): key is NavigationKey {
  return ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)
}
