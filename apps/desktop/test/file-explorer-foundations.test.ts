import { describe, expect, it } from 'vitest'
import { createFileExplorerDirLoadTracker } from '../src/renderer/src/components/file-tree/file-explorer-dir-load-tracker.js'
import { resolveFileExplorerNavigationTarget } from '../src/renderer/src/components/file-tree/file-explorer-keyboard-navigation.js'
import {
  getRevealAncestorPaths,
  isPathWithinSubtree,
  remapPathWithinSubtree
} from '../src/renderer/src/lib/workspace-paths.js'
import { createFileExplorerRowProjection } from '../src/renderer/src/components/file-tree/file-explorer-row-projection.js'
import {
  createEmptyFileExplorerSelection,
  createSingleFileExplorerSelection,
  getFileExplorerSelectionMode,
  updateFileExplorerSelection,
  updateFileExplorerSelectionPaths
} from '../src/renderer/src/components/file-tree/file-explorer-selection.js'
import {
  collectStaleDirCachePaths,
  decideExpandedDirLoad
} from '../src/renderer/src/components/file-tree/file-explorer-stale-dir-cache.js'
import type { DirCache, TreeNode } from '../src/renderer/src/components/file-tree/file-explorer-types.js'

function node(path: string, depth: number, isDirectory = false): TreeNode {
  return {
    name: path.split('/').at(-1) ?? path,
    path,
    relativePath: path,
    isDirectory,
    isSymlink: false,
    depth
  }
}

const rows = [
  node('src', 0, true),
  node('src/a.ts', 1),
  node('src/nested', 1, true),
  node('src/nested/b.ts', 2),
  node('README.md', 0)
]

describe('Orca-derived explorer row projection and navigation', () => {
  const projection = createFileExplorerRowProjection(rows)

  it('moves, jumps, enters children, returns to parents, and toggles directories', () => {
    const collapsed = () => false
    const expanded = (path: string) => path === 'src'
    expect(resolveFileExplorerNavigationTarget({ key: 'ArrowDown', currentIndex: 0, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'move', targetIndex: 1 })
    expect(resolveFileExplorerNavigationTarget({ key: 'Home', currentIndex: 4, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'move', targetIndex: 0 })
    expect(resolveFileExplorerNavigationTarget({ key: 'End', currentIndex: 0, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'move', targetIndex: 4 })
    expect(resolveFileExplorerNavigationTarget({ key: 'ArrowRight', currentIndex: 0, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'toggle-expand', currentIndex: 0, dirPath: 'src' })
    expect(resolveFileExplorerNavigationTarget({ key: 'ArrowRight', currentIndex: 0, rowProjection: projection, total: 5, isExpanded: expanded })).toEqual({ type: 'move', targetIndex: 1 })
    expect(resolveFileExplorerNavigationTarget({ key: 'ArrowLeft', currentIndex: 3, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'move', targetIndex: 2 })
  })

  it('projects selected paths in visible tree order', () => {
    expect(projection.getRowsByPaths(new Set(['README.md', 'src/a.ts'])).map((item) => item.path)).toEqual(['src/a.ts', 'README.md'])
    expect(projection.getParentIndex(3)).toBe(2)
    expect(projection.getFirstChildIndex(2)).toBe(3)
  })
})

describe('Orca-derived explorer selection and mutation reconciliation', () => {
  const ordered = rows.map((item) => item.path)

  it('supports platform toggle and range selection', () => {
    expect(getFileExplorerSelectionMode({ ctrlKey: false, metaKey: true, shiftKey: false }, true)).toBe('toggle')
    const first = updateFileExplorerSelection(createEmptyFileExplorerSelection(), ordered, 'src/a.ts', 'replace')
    const range = updateFileExplorerSelection(first, ordered, 'src/nested/b.ts', 'range')
    expect([...range.selectedPaths]).toEqual(['src/a.ts', 'src/nested', 'src/nested/b.ts'])
  })

  it('remaps rename descendants and removes deleted subtrees without losing unrelated selection', () => {
    const selected = {
      ...createSingleFileExplorerSelection('src/nested/b.ts'),
      selectedPaths: new Set(['src/nested/b.ts', 'README.md'])
    }
    const renamed = updateFileExplorerSelectionPaths(selected, (path) =>
      remapPathWithinSubtree(path, 'src/nested', 'src/moved')
    )
    expect([...renamed.selectedPaths]).toEqual(['src/moved/b.ts', 'README.md'])
    const afterDelete = updateFileExplorerSelectionPaths(renamed, (path) =>
      isPathWithinSubtree(path, 'src/moved') ? null : path
    )
    expect([...afterDelete.selectedPaths]).toEqual(['README.md'])
    expect(afterDelete.activePath).toBe('README.md')
  })

  it('does not treat a string-prefix neighbor as part of the same path subtree', () => {
    expect(isPathWithinSubtree('src/app', 'src/app')).toBe(true)
    expect(isPathWithinSubtree('src/app/index.ts', 'src/app')).toBe(true)
    expect(isPathWithinSubtree('src/application.ts', 'src/app')).toBe(false)
    expect(remapPathWithinSubtree('src/application.ts', 'src/app', 'src/moved')).toBe('src/application.ts')
  })
})

describe('Orca-derived reveal, refresh, and stale-response primitives', () => {
  it('builds reveal ancestors for a relative Workspace path', () => {
    expect(getRevealAncestorPaths('src/components/App.tsx')).toEqual(['src', 'src/components'])
  })

  it('rejects stale same-directory and prior-Workspace load completions', () => {
    const tracker = createFileExplorerDirLoadTracker()
    const first = tracker.begin('src')
    const second = tracker.begin('src')
    expect(tracker.isCurrent(first)).toBe(false)
    expect(tracker.isCurrent(second)).toBe(true)
    tracker.reset()
    expect(tracker.isCurrent(second)).toBe(false)
  })

  it('marks collapsed caches stale and forces their next expansion to reload', () => {
    const cache: Record<string, DirCache> = {
      '': { children: rows, loading: false },
      src: { children: rows.slice(1, 4), loading: false },
      'src/nested': { children: [rows[3]!], loading: false }
    }
    expect(collectStaleDirCachePaths(cache, '', new Set(['src']))).toEqual(['src/nested'])
    expect(decideExpandedDirLoad(cache['src/nested'], true)).toBe('reload')
    expect(decideExpandedDirLoad(cache.src, false)).toBe('skip')
  })
})
