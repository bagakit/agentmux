import { describe, expect, it, vi } from 'vitest'
import {
  createFileExplorerDirLoadScope,
  createFileExplorerDirLoadTracker
} from '../src/renderer/src/components/file-tree/file-explorer-dir-load-tracker.js'
import { resolveFileExplorerNavigationTarget } from '../src/renderer/src/components/file-tree/file-explorer-keyboard-navigation.js'
import {
  getRevealAncestorPaths,
  isPathWithinSubtree,
  joinWorkspacePath,
  remapPathWithinSubtree
} from '../src/renderer/src/lib/workspace-paths.js'
import { createFileExplorerRowProjection } from '../src/renderer/src/components/file-tree/file-explorer-row-projection.js'
import {
  createEmptyFileExplorerSelection,
  createSingleFileExplorerSelection,
  getFileExplorerSelectionMode,
  revealFileExplorerPath,
  updateFileExplorerSelection,
  updateFileExplorerSelectionPaths
} from '../src/renderer/src/lib/file-explorer-selection.js'
import {
  collectStaleDirCachePaths,
  decideExpandedDirLoad
} from '../src/renderer/src/components/file-tree/file-explorer-stale-dir-cache.js'
import type { DirCache, TreeNode } from '../src/renderer/src/components/file-tree/file-explorer-types.js'
import {
  fileExplorerDropDirectory,
  fileExplorerMoveTargets,
  isFileExplorerMenuKey,
  planFileExplorerMove,
  runFileExplorerMove
} from '../src/renderer/src/lib/file-explorer-move.js'

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

describe('file explorer context paths', () => {
  it('builds host-native absolute paths for context-menu actions', () => {
    expect(joinWorkspacePath('/srv/project/', 'src/index.ts')).toBe('/srv/project/src/index.ts')
    expect(joinWorkspacePath('C:\\work\\project\\', 'src/index.ts')).toBe('C:\\work\\project\\src\\index.ts')
  })
})

describe('file explorer move interaction', () => {
  it('resolves directory, file-row parent, root, and segment-aware menu targets', () => {
    expect(fileExplorerDropDirectory(node('src/lib', 0, true))).toBe('src/lib')
    expect(fileExplorerDropDirectory(node('src/lib/file.ts', 0))).toBe('src/lib')
    expect(fileExplorerMoveTargets([
      node('src', 0, true),
      node('src/app', 1, true),
      node('src/application', 1, true),
      node('lib', 0, true)
    ], 'src/app')).toEqual([
      { path: '', label: 'Workspace Root' },
      { path: 'src/application', label: 'src/application' },
      { path: 'lib', label: 'lib' }
    ])
  })

  it('plans one loaded-tree move and blocks invalid drop and menu destinations', () => {
    const nodes = [
      node('src', 0, true),
      node('src/app', 1, true),
      node('src/app/index.ts', 2),
      node('lib', 0, true),
      node('lib/app', 1, true)
    ]
    expect(planFileExplorerMove(nodes, 'src/app/index.ts', 'lib')).toEqual({
      status: 'ready',
      sourcePath: 'src/app/index.ts',
      directoryPath: 'lib',
      destinationPath: 'lib/index.ts'
    })
    expect(planFileExplorerMove(nodes, 'src/app/index.ts', 'src/app')).toEqual({
      status: 'blocked', reason: 'same-parent'
    })
    expect(planFileExplorerMove(nodes, 'src/app', 'src/app')).toEqual({
      status: 'blocked', reason: 'into-self'
    })
    expect(planFileExplorerMove(nodes, 'src/app', 'src/app/nested')).toEqual({
      status: 'blocked', reason: 'into-self'
    })
    expect(planFileExplorerMove(nodes, 'src/app', 'lib')).toEqual({
      status: 'blocked', reason: 'destination-exists'
    })
    expect(fileExplorerMoveTargets(nodes, 'src/app').map((target) => target.path)).not.toContain('lib')
  })

  it('refreshes exactly both move parents on success and after an unknown receipt', async () => {
    const refresh = vi.fn(async () => {})
    const move = vi.fn(async () => {})
    await runFileExplorerMove({
      sourcePath: 'src/app/index.ts',
      destinationPath: 'lib/index.ts',
      move,
      refreshDirectory: refresh
    })
    expect(move).toHaveBeenCalledWith('src/app/index.ts', 'lib/index.ts')
    expect(refresh.mock.calls.map(([path]) => path)).toEqual(['src/app', 'lib'])

    refresh.mockClear()
    const unknown = Object.assign(new Error('unknown'), { finalLocation: 'unknown' })
    await expect(runFileExplorerMove({
      sourcePath: 'src/app',
      destinationPath: 'src/renamed',
      move: async () => { throw unknown },
      refreshDirectory: refresh
    })).rejects.toBe(unknown)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('src')
  })

  it('keeps confirmed failures unchanged and exposes the menu from keyboard conventions', async () => {
    const refresh = vi.fn(async () => {})
    const collision = Object.assign(new Error('collision'), { finalLocation: 'source' })
    await expect(runFileExplorerMove({
      sourcePath: 'src/app',
      destinationPath: 'lib/app',
      move: async () => { throw collision },
      refreshDirectory: refresh
    })).rejects.toBe(collision)
    expect(refresh).not.toHaveBeenCalled()
    expect(isFileExplorerMenuKey({ key: 'ContextMenu', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })).toBe(true)
    expect(isFileExplorerMenuKey({ key: 'F10', shiftKey: true, altKey: false, ctrlKey: false, metaKey: false })).toBe(true)
    expect(isFileExplorerMenuKey({ key: 'F10', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })).toBe(false)
  })
})

describe('file explorer row projection and navigation', () => {
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

describe('file explorer selection and mutation reconciliation', () => {
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

  it('reveals an active path without replacing an existing multi-selection', () => {
    const selection = {
      activePath: 'src/moved/index.ts',
      anchorPath: 'src/moved/index.ts',
      selectedPaths: new Set(['src/moved/index.ts', 'src/application.ts'])
    }
    const current = {
      selection,
      expandedPaths: new Set(['src'])
    }

    const revealed = revealFileExplorerPath(current, 'src/moved/index.ts')

    expect(revealed.selection).toBe(selection)
    expect(revealed.selection.selectedPaths).toEqual(
      new Set(['src/moved/index.ts', 'src/application.ts'])
    )
    expect(revealed.expandedPaths).toEqual(new Set(['src', 'src/moved']))
    expect(revealFileExplorerPath(revealed, 'src/moved/index.ts')).toBe(revealed)
  })
})

describe('file explorer reveal, refresh, and stale-response primitives', () => {
  it('builds reveal ancestors for a relative Workspace path', () => {
    expect(getRevealAncestorPaths('src/components/App.tsx')).toEqual(['src', 'src/components'])
  })

  it('rejects stale same-directory completions and prior-Workspace late starts', () => {
    const tracker = createFileExplorerDirLoadTracker()
    const firstWorkspaceA = createFileExplorerDirLoadScope('workspace-a')
    const workspaceB = createFileExplorerDirLoadScope('workspace-b')
    const secondWorkspaceA = createFileExplorerDirLoadScope('workspace-a')
    tracker.activate(firstWorkspaceA)
    const first = tracker.begin(firstWorkspaceA, 'src')!
    const second = tracker.begin(firstWorkspaceA, 'src')!
    expect(tracker.isCurrent(first)).toBe(false)
    expect(tracker.isCurrent(second)).toBe(true)
    tracker.activate(workspaceB)
    expect(tracker.isCurrent(second)).toBe(false)
    expect(tracker.begin(firstWorkspaceA, 'src')).toBeNull()
    const staleDirs = new Set<string>()
    expect(tracker.runIfActive(firstWorkspaceA, () => staleDirs.add('src'))).toBe(false)
    expect(staleDirs).toEqual(new Set())
    tracker.activate(secondWorkspaceA)
    expect(tracker.begin(firstWorkspaceA, 'src')).toBeNull()
    expect(tracker.begin(secondWorkspaceA, 'src')).not.toBeNull()
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
