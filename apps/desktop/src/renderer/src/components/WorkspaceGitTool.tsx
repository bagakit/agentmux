import { useRef } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useGitHistory } from '../features/git/history/useGitHistory'
import { useGitHistoryReader, useSharedGitHistory } from '../features/git/history/GitHistoryContext'
import type { GitHistoryViewportState } from '../features/git/history/GitHistoryPanel'
import { useAppStore } from '../store'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { useGitStatus } from '../hooks/useGitStatus'
import type { WorkspaceGitView } from '../lib/workspace-git-view'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { BranchesPanel } from './BranchesPanel'
import { ChangesPanel } from './ChangesPanel'
import { GitHistoryPanel } from '../features/git/history/GitHistoryPanel'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'

const ThemeObjectRepositoryIcon = semanticIconComponent('object.repository')
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
  const view = useAppStore(state => state.workspaceGitView)
  const setView = useAppStore(state => state.setWorkspaceGitView)
  const displayPath = usePathDisplay()
  const openCommit = useAppStore(state => state.openGitWorkbench), openHistory = useAppStore(state => state.openGitHistory)
  const showDetails = useAppStore(state => state.showGitCommitDetails)
  const reading = visible && view === 'history'
  useGitHistoryReader(shared, 'sidebar:' + workspace.id, workspace, 'sidebar', reading)
  const ready = history.result?.kind === 'ready' ? history.result : null
  return <section className="workspace-git-tool content-slot-source-control" aria-label="Git tools" data-git-workspace={workspace.id}>
    <div className="workspace-tool-context workspace-git-context" title={displayPath(workspace.path, workspace.hostId)}>
      <ThemeObjectRepositoryIcon size={13} aria-hidden="true" />
      <span><strong>{workspace.name}</strong></span>
      <em>{workspace.hostId === 'local' ? 'Local' : workspace.hostId}</em>
    </div>
    <div className="workspace-git-path" title={displayPath(workspace.path, workspace.hostId)}>{displayPath(workspace.path, workspace.hostId)}</div>
    <SurfaceModeSwitch value={view} options={VIEWS} onChange={(next: WorkspaceGitView) => setView(next)} active={visible} ariaLabel="Git view" />
    <div className="workspace-git-panel" hidden={view !== 'branches'}>
      <BranchesPanel workspace={workspace} active={visible && view === 'branches'} />
    </div>
    <div className="workspace-git-panel" hidden={view !== 'changes'}>
      <ChangesPanel workspace={workspace} active={visible && view === 'changes'} />
    </div>
    <div className="source-control-history" hidden={view !== 'history'}>
      {shared?.repositoryRegionId ? <div className="git-history-expanded" role="status">
        <span>History is open in the main area.</span>
        {ready && <button className="small-button" onClick={() => openHistory(workspace.id, ready.snapshot, history.reference)}>Go to history</button>}
        <button className="small-button" onClick={() => showDetails(shared.repositoryRegionId!)}>Show history here</button>
      </div> : <GitHistoryPanel workspace={workspace} history={history} viewportState={viewportState}
        onSelectCommit={snapshot => openCommit(workspace.id, snapshot)}
        {...(ready ? { onOpenRepository: () => openHistory(workspace.id, ready.snapshot, history.reference) } : {})} />}
    </div>
  </section>
}

export function WorkspaceChangesSummary({ workspace, active, onOpen }: { workspace: WorkspaceRecord; active: boolean; onOpen(): void }) {
  const { status, loading, error } = useGitStatus(workspace.id, active)
  const label = error ? 'Changes unavailable' : status?.kind === 'git-repository'
    ? `${status.changes.length} changed ${status.changes.length === 1 ? 'file' : 'files'}`
    : loading ? 'Checking changes…' : status?.kind === 'not-a-git-repository' ? 'No Git repository' : 'Changes unknown'
  return <button type="button" className="workspace-changes-summary" onClick={onOpen}
    aria-label="Open changes for this Zone" title={error ?? `Changes in ${workspace.path}`}>
    <ThemeObjectRepositoryIcon size={12} aria-hidden="true" /><span>{label}</span><small>Git</small>
  </button>
}
