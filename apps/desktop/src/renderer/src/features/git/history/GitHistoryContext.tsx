import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { WorkspaceRecord } from '../../../../../shared/contracts'
import { useGitHistory } from './useGitHistory'
import type { GitHistoryViewportState } from './GitHistoryPanel'
import { useAppStore } from '../../../store'
import { mainRegionReference } from '../../../lib/desktop-focus-navigation'

const EMPTY_WORKSPACE = { id: '', hostId: '', path: '' }
export const gitWorkspaceKey = (workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>) => JSON.stringify([workspace.id, workspace.hostId, workspace.path])
type Reader = { scope: string; kind: 'sidebar' | 'repository'; visible: boolean; reference: string | null | undefined }
type ReadingContext = {
  scope: string
  history: ReturnType<typeof useGitHistory>
  viewportState: RefObject<GitHistoryViewportState | null>
  repositoryRegionId: string | null
  register(id: string, scope: string, kind: Reader['kind'], visible: boolean, reference: string | null | undefined): () => void
}
const GitHistoryContext = createContext<ReadingContext | null>(null)

/** One local reading window shared by the active Workspace's tools and main workface.
 * No cache or resource identity is inferred from focus. Other Workspace views keep their own reader. */
export function GitHistoryProvider({ workspace, children }: { workspace: WorkspaceRecord | null | undefined; children: ReactNode }) {
  const scope = gitWorkspaceKey(workspace ?? EMPTY_WORKSPACE)
  const [readers, setReaders] = useState<Record<string, Reader>>({})
  const currentReaders = Object.entries(readers).filter(([, reader]) => reader.scope === scope)
  const repositoryReaders = currentReaders.filter(([, reader]) => reader.kind === 'repository')
  const focusedRegionId = useAppStore(state => state.mainSurface === 'workbench' ? mainRegionReference(state.workbenchSpaceSelection)?.regionId ?? null : null)
  const visibleRepositories = repositoryReaders.filter(([, reader]) => reader.visible)
  const restoringReader = visibleRepositories.find(([regionId]) => regionId === focusedRegionId) ?? visibleRepositories.at(-1)
  const repositoryRegionId = restoringReader?.[0] ?? repositoryReaders.at(-1)?.[0] ?? null
  const enabled = Boolean(workspace && currentReaders.some(([, reader]) => reader.kind === 'sidebar'))
  const history = useGitHistory(workspace ?? EMPTY_WORKSPACE, enabled)
  useLayoutEffect(() => {
    if (restoringReader && restoringReader[1].reference !== undefined) history.restoreReference(restoringReader[1].reference)
  }, [restoringReader?.[0], restoringReader?.[1].reference, history.restoreReference])
  const viewportState = useRef<GitHistoryViewportState | null>(null)
  const register = useCallback((id: string, scope: string, kind: Reader['kind'], visible: boolean, reference: string | null | undefined) => {
    setReaders(previous => ({ ...previous, [id]: { scope, kind, visible, reference } }))
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
export function useGitHistoryReader(shared: ReadingContext | null, id: string, workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>, kind: Reader['kind'], visible: boolean, reference?: string | null) {
  const register = shared?.register, scope = gitWorkspaceKey(workspace)
  useLayoutEffect(() => register && (visible || kind === 'repository') ? register(id, scope, kind, visible, reference) : undefined, [register, id, scope, kind, visible, reference])
}
