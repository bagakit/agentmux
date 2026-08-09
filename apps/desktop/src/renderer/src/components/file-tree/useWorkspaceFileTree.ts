// Workspace-scoped load admission owns the Explorer cache projection so late
// Local or system-SSH reads cannot cross a Workspace identity boundary.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import {
  createFileExplorerDirLoadScope,
  createFileExplorerDirLoadTracker
} from './file-explorer-dir-load-tracker'
import { recordRejectedFileExplorerDirectoryLoad } from './file-explorer-report-probe'
import {
  collectStaleDirCachePaths,
  decideExpandedDirLoad
} from './file-explorer-stale-dir-cache'
import type { DirCache, TreeNode } from './file-explorer-types'

function pathDepth(path: string): number {
  return path ? path.split('/').length - 1 : -1
}

export function flattenFileTree(
  root: readonly TreeNode[],
  dirCache: Readonly<Record<string, DirCache>>,
  expanded: ReadonlySet<string>
): TreeNode[] {
  const rows: TreeNode[] = []
  const visit = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      rows.push(node)
      if (node.isDirectory && expanded.has(node.path)) {
        visit(dirCache[node.path]?.children ?? [])
      }
    }
  }
  visit(root)
  return rows
}

export function useWorkspaceFileTree(workspaceId: string, expanded: ReadonlySet<string>) {
  const [dirCache, setDirCache] = useState<Record<string, DirCache>>({})
  const cacheRef = useRef(dirCache)
  const loadTrackerRef = useRef(createFileExplorerDirLoadTracker())
  const staleDirsRef = useRef(new Set<string>())
  const loadScope = useMemo(() => createFileExplorerDirLoadScope(workspaceId), [workspaceId])
  cacheRef.current = dirCache

  const loadDir = useCallback(
    async (path: string, options?: { force?: boolean; failOnError?: boolean }) => {
      const cached = cacheRef.current[path]
      const decision = decideExpandedDirLoad(cached, staleDirsRef.current.has(path))
      if (!options?.force && decision === 'skip') return true

      const token = loadTrackerRef.current.begin(loadScope, path)
      if (!token) {
        recordRejectedFileExplorerDirectoryLoad(loadTrackerRef.current.reject(loadScope, path))
        return false
      }
      setDirCache((previous) => ({
        ...previous,
        // Force refresh retains the old children so the tree does not collapse
        // while Local or SSH is answering.  The previous error is dropped here on
        // purpose: a read that is in flight is not a read that has failed.
        [path]: { children: previous[path]?.children ?? [], loading: true, error: null }
      }))
      try {
        const entries = await api.files.readDirectory(workspaceId, path)
        if (!loadTrackerRef.current.isCurrent(token)) return false
        const children = entries.map((entry) => ({
          ...entry,
          relativePath: entry.path,
          depth: pathDepth(path) + 1
        }))
        staleDirsRef.current.delete(path)
        setDirCache((previous) => ({
          ...previous,
          [path]: { children, loading: false, error: null }
        }))
        return true
      } catch (error) {
        if (!loadTrackerRef.current.isCurrent(token)) return false
        const reason = error instanceof Error ? error.message : String(error)
        setDirCache((previous) => ({
          ...previous,
          // 子目录的失败此前在这里被完全丢弃（只有根目录进一个独立的 rootError state），于是读失败
          // 与真的空目录在 cache 里逐字同形，树上都画成一个展开的空文件夹。原因记进 cache，让
          // presentExpandedDir 能把两者分开；根目录的错误也从这一处派生，不再有第二个写者。
          [path]: { children: previous[path]?.children ?? [], loading: false, error: reason }
        }))
        return !options?.failOnError
      }
    },
    [loadScope, workspaceId]
  )

  useLayoutEffect(() => {
    loadTrackerRef.current.activate(loadScope)
    return () => {
      loadTrackerRef.current.deactivate(loadScope)
    }
  }, [loadScope])

  useEffect(() => {
    staleDirsRef.current.clear()
    // The expanded-path effect runs in the same commit. Clear its synchronous
    // decision source before scheduling React state so it cannot reuse the
    // previous Workspace's loaded/loading entries.
    cacheRef.current = {}
    setDirCache({})
    void loadDir('', { force: true })
  }, [loadDir, loadScope])

  useEffect(() => {
    for (const path of expanded) {
      const decision = decideExpandedDirLoad(
        cacheRef.current[path],
        staleDirsRef.current.has(path)
      )
      if (decision !== 'skip') {
        void loadDir(path, decision === 'reload' ? { force: true } : undefined)
      }
    }
  }, [expanded, loadDir])

  const refreshTree = useCallback(async () => {
    const admitted = loadTrackerRef.current.runIfActive(loadScope, () => {
      for (const path of collectStaleDirCachePaths(cacheRef.current, '', expanded)) {
        staleDirsRef.current.add(path)
      }
    })
    if (!admitted) return false
    const rootLoaded = await loadDir('', { force: true, failOnError: true })
    if (!rootLoaded) return false
    const paths = [...expanded]
    for (let index = 0; index < paths.length; index += 4) {
      await Promise.all(
        paths.slice(index, index + 4).map((path) => loadDir(path, { force: true }))
      )
    }
    return true
  }, [expanded, loadDir, loadScope])

  const refreshDir = useCallback(
    async (path: string) => await loadDir(path, { force: true }),
    [loadDir]
  )

  return {
    dirCache,
    rootCache: dirCache[''],
    // 根目录的错误从 cache 派生，而不是另存一份 state：它与子目录的错误是同一件事，两个写者必漂移。
    rootError: dirCache['']?.error ?? null,
    loadDir,
    refreshDir,
    refreshTree,
    isDirStale: (path: string) => staleDirsRef.current.has(path)
  }
}

export type { DirCache, TreeNode } from './file-explorer-types'
