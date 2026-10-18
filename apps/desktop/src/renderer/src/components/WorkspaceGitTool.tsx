import { useCallback, useMemo, useRef } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useGitHistory } from '../features/git/history/useGitHistory'
import { useGitHistoryReader, useSharedGitHistory } from '../features/git/history/GitHistoryContext'
import type { GitHistoryViewportState } from '../features/git/history/GitHistoryPanel'
import { useAppStore } from '../store'
import { findWorkbenchRegion } from '../lib/workbench-tabs'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { useGitStatus } from '../hooks/useGitStatus'
import type { WorkspaceGitView } from '../lib/workspace-git-view'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { BranchesPanel } from './BranchesPanel'
import { ChangesPanel } from './ChangesPanel'
import { GitHistoryPanel } from '../features/git/history/GitHistoryPanel'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { useWorkspaceZoneContext } from '../lib/workspace-zone-context'

const ThemeObjectRepositoryIcon = semanticIconComponent('object.repository')
const ThemeNavigationForwardIcon = semanticIconComponent('navigation.forward')
const VIEWS = [{ value: 'changes', label: 'Changes' }, { value: 'history', label: 'History' }, { value: 'branches', label: 'Branches' }] as const

export function WorkspaceGitTool(props: {
  workspace: WorkspaceRecord; visible: boolean
}) {
  const shared = useSharedGitHistory(props.workspace)
  const view = useAppStore(state => state.workspaceGitView)
  const history = useGitHistory(props.workspace, !shared && props.visible && view === 'history')
  const viewportState = useRef<GitHistoryViewportState | null>(null)
  return <SourceControl {...props} history={shared?.history ?? history} shared={shared} viewportState={shared?.viewportState ?? viewportState} />
}
function SourceControl({ workspace, visible, history, shared, viewportState }: {
  workspace: WorkspaceRecord; visible: boolean
  history: ReturnType<typeof useGitHistory>; shared: ReturnType<typeof useSharedGitHistory>
  viewportState: React.RefObject<GitHistoryViewportState | null>
}) {
  const zoneContext = useWorkspaceZoneContext(workspace)
  const view = useAppStore(state => state.workspaceGitView)
  const setView = useAppStore(state => state.setWorkspaceGitView)
  const displayPath = usePathDisplay()
  const openHistory = useAppStore(state => state.openGitHistory)
  const selectCommit = useAppStore(state => state.selectGitCommit)
  const selectReference = useAppStore(state => state.selectGitHistoryReference)
  const tabs = useAppStore(state => state.tabs)
  const region = useMemo(() => shared?.repositoryRegionId ? findWorkbenchRegion(tabs, shared.repositoryRegionId)?.surface : undefined,
    [tabs, shared?.repositoryRegionId])
  const review = region?.kind === 'git' ? region : null
  const reading = visible && view === 'history'
  useGitHistoryReader(shared, 'sidebar:' + workspace.id, workspace, 'sidebar', reading)
  const ready = history.result?.kind === 'ready' ? history.result : null
  const sameRepository = Boolean(history.repository && review && history.repository.hostId === review.scope.hostId && history.repository.repoPath === review.scope.repoPath)
  const focusOid = sameRepository ? review?.history?.focusOid : undefined
  const found = Boolean(focusOid && ready?.commits.some(commit => commit.oid === focusOid))
  const chooseReference = useCallback((reference: string | null) => {
    history.selectReference(reference)
    if (review && (!history.repository || sameRepository)) selectReference(review.regionId, reference)
  }, [history.selectReference, history.repository, review, sameRepository, selectReference])
  const navigation = useMemo(() => ({ ...history, selectReference: chooseReference }), [history, chooseReference])
  return <section className="workspace-git-tool content-slot-source-control" aria-label="Git tools" data-git-workspace={workspace.id}>
    <div className="workspace-tool-context workspace-git-context" title={displayPath(workspace.path, workspace.hostId)}>
      <ThemeObjectRepositoryIcon size={13} aria-hidden="true" />
      <span><strong>{workspace.name}</strong></span>
      <em>{workspace.hostId === 'local' ? 'Local' : workspace.hostId}</em>
    </div>
    <div className="workspace-git-path" title={displayPath(workspace.path, workspace.hostId)}>{displayPath(workspace.path, workspace.hostId)}</div>
    <SurfaceModeSwitch value={view} options={VIEWS} onChange={(next: WorkspaceGitView) => setView(next)} active={visible} ariaLabel="Git view" />
    <div className="workspace-git-panel" hidden={view !== 'branches'}>
      <BranchesPanel workspace={workspace} zoneContext={zoneContext} active={visible && view === 'branches'} />
    </div>
    <div className="workspace-git-panel" hidden={view !== 'changes'}>
      <ChangesPanel workspace={workspace} active={visible && view === 'changes'} />
    </div>
    <div className="source-control-history" hidden={view !== 'history'}>
      {focusOid && !found && <div className="git-workbench__locating" role="status">
        <span>{history.error ? 'Locating paused. Retry history to continue.' : ready && !ready.nextCursor ? 'This commit is outside the current history range.' : 'This commit has not been loaded in the current range.'}</span>
        {ready?.nextCursor && <button className="small-button" disabled={history.loading} onClick={() => void history.loadMore()}>Read next history page</button>}
      </div>}
      <GitHistoryPanel workspace={workspace} history={navigation} viewportState={viewportState}
        onSelectCommit={snapshot => {
          const opened = openHistory(workspace.id, snapshot, history.reference)
          selectCommit(opened.regionId, snapshot)
        }}
        {...(sameRepository && review?.selection ? { selectedOid: review.selection.commitOid } : {})}
        {...(found && focusOid ? { revealOid: focusOid } : {})} />
    </div>
  </section>
}

export function WorkspaceChangesSummary({ workspace, active, onOpen }: { workspace: WorkspaceRecord; active: boolean; onOpen(): void }) {
  const { status, loading, error } = useGitStatus(workspace.id, active)
  const displayPath = usePathDisplay()
  const label = error ? 'Changes unavailable' : status?.kind === 'git-repository'
    ? `${status.changes.length} changed ${status.changes.length === 1 ? 'file' : 'files'}`
    : loading ? 'Checking changes…' : status?.kind === 'not-a-git-repository' ? 'No Git repository' : 'Changes unknown'
  const branch = status?.kind === 'git-repository' ? status.branch : workspace.branch
  const scope = `${workspace.kind === 'worktree' ? 'Current worktree' : 'Current folder'} · ${branch ?? workspace.name}`
  return <button type="button" className="workspace-changes-summary" onClick={onOpen} data-workspace-id={workspace.id}
    aria-label="Open changes for this Zone" title={[scope, `${displayPath(workspace.path, workspace.hostId)} · ${workspace.hostId}`, error].filter(Boolean).join('\n')}>
    <ThemeObjectRepositoryIcon size={13} aria-hidden="true" /><span><strong>{label}</strong><small>{scope}</small></span>
    <ThemeNavigationForwardIcon size={12} aria-hidden="true" />
  </button>
}
