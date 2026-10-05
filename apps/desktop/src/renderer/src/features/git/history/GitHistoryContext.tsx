import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { WorkspaceRecord } from '../../../../../shared/contracts'
import { useGitHistory } from './useGitHistory'
import type { GitHistoryViewportState } from './GitHistoryPanel'

const EMPTY_WORKSPACE = { id: '', hostId: '', path: '' }
export const gitWorkspaceKey = (workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>) => JSON.stringify([workspace.id, workspace.hostId, workspace.path])
type Reader = { scope: string; kind: 'sidebar' | 'repository' }
type ReadingContext = {
  scope: string
  history: ReturnType<typeof useGitHistory>
  viewportState: RefObject<GitHistoryViewportState | null>
  repositoryRegionId: string | null
  register(id: string, scope: string, kind: Reader['kind']): () => void
}
const GitHistoryContext = createContext<ReadingContext | null>(null)

/** One local reading window shared by the active Workspace's tools and main workface.
 * No cache or resource identity is inferred from focus. Other Workspace views keep their own reader. */
export function GitHistoryProvider({ workspace, children }: { workspace: WorkspaceRecord | null | undefined; children: ReactNode }) {
  const scope = gitWorkspaceKey(workspace ?? EMPTY_WORKSPACE)
  const [readers, setReaders] = useState<Record<string, Reader>>({})
  const currentReaders = Object.entries(readers).filter(([, reader]) => reader.scope === scope)
  const repositoryRegionId = currentReaders.find(([, reader]) => reader.kind === 'repository')?.[0] ?? null
  const enabled = Boolean(workspace && currentReaders.length)
  const history = useGitHistory(workspace ?? EMPTY_WORKSPACE, enabled)
  const viewportState = useRef<GitHistoryViewportState | null>(null)
  const register = useCallback((id: string, scope: string, kind: Reader['kind']) => {
    setReaders(previous => ({ ...previous, [id]: { scope, kind } }))
    return () => setReaders(previous => {
      if (previous[id]?.scope !== scope) return previous
      const next = { ...previous }; delete next[id]; return next
    })
  }, [])
  const value = useMemo(() => ({ scope, history, viewportState, repositoryRegionId, register }), [scope, history, repositoryRegionId, register])
  return <GitHistoryContext.Provider value={value}>{children}</GitHistoryContext.Provider>
}
export function useSharedGitHistory(workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>) {
  const shared = useContext(GitHistoryContext)
  return shared?.scope === gitWorkspaceKey(workspace) ? shared : null
}
export function useGitHistoryReader(shared: ReadingContext | null, id: string, workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>, kind: Reader['kind'], visible: boolean) {
  const register = shared?.register, scope = gitWorkspaceKey(workspace)
  useEffect(() => visible && register ? register(id, scope, kind) : undefined, [register, id, scope, kind, visible])
}
