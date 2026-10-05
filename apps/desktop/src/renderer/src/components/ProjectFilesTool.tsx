import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useGitHistory } from '../features/git/history/useGitHistory'
import { useGitHistoryReader, useSharedGitHistory } from '../features/git/history/GitHistoryContext'
import type { GitHistoryViewportState } from '../features/git/history/GitHistoryPanel'
import { useAppStore } from '../store'
import { contentSlotPresentation } from '../lib/surface-tool-dock'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { BranchesPanel } from './BranchesPanel'
import { ChangesPanel } from './ChangesPanel'
import { GitHistoryPanel } from '../features/git/history/GitHistoryPanel'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { WorkspaceFilesFrame, type WorkspaceFileActions } from './WorkspaceFilesFrame'

type ProjectView = 'branches' | 'changes' | 'history'
const VIEWS = [{ value: 'branches', label: 'Branches' }, { value: 'changes', label: 'Changes' }, { value: 'history', label: 'History' }] as const

/** The sidebar and expanded repository consume one local reading window. */
export function ProjectSourceControl(props: {
  workspace: WorkspaceRecord; visible: boolean; children(content: ReactNode): ReactNode
}) {
  const shared = useSharedGitHistory(props.workspace)
  return shared ? <SourceControl {...props} history={shared.history} shared={shared} viewportState={shared.viewportState} /> : <LocalSourceControl {...props} />
}
function LocalSourceControl(props: { workspace: WorkspaceRecord; visible: boolean; children(content: ReactNode): ReactNode }) {
  const [reading, setReading] = useState(false)
  const history = useGitHistory(props.workspace, props.visible && reading)
  const viewportState = useRef<GitHistoryViewportState | null>(null)
  return <SourceControl {...props} history={history} shared={null} viewportState={viewportState} onReading={setReading} />
}
function SourceControl({ workspace, visible, children, history, shared, viewportState, onReading }: {
  workspace: WorkspaceRecord; visible: boolean; children(content: ReactNode): ReactNode
  history: ReturnType<typeof useGitHistory>; shared: ReturnType<typeof useSharedGitHistory>
  viewportState: React.RefObject<GitHistoryViewportState | null>; onReading?(reading: boolean): void
}) {
  const [view, setView] = useState<ProjectView>('branches')
  const openCommit = useAppStore(state => state.openGitWorkbench), openHistory = useAppStore(state => state.openGitHistory)
  const showDetails = useAppStore(state => state.showGitCommitDetails)
  const reading = visible && view === 'history'
  useGitHistoryReader(shared, 'sidebar:' + workspace.id, workspace, 'sidebar', reading)
  useEffect(() => { onReading?.(view === 'history') }, [view, onReading])
  const ready = history.result?.kind === 'ready' ? history.result : null
  return children(<div className="content-slot-source-control">
    <SurfaceModeSwitch value={view} options={VIEWS} onChange={setView} active={visible} ariaLabel="Source control view" />
    {view === 'branches' && <BranchesPanel workspace={workspace} />}
    {view === 'changes' && <ChangesPanel workspace={workspace} />}
    <div className="source-control-history" hidden={view !== 'history'}>
      {shared?.repositoryRegionId ? <div className="git-history-expanded" role="status">
        <span>History is open in the main area.</span>
        {ready && <button className="small-button" onClick={() => openHistory(workspace.id, ready.snapshot, history.reference)}>Go to history</button>}
        <button className="small-button" onClick={() => showDetails(shared.repositoryRegionId!)}>Show history here</button>
      </div> : <GitHistoryPanel workspace={workspace} history={history} viewportState={viewportState}
        onSelectCommit={snapshot => openCommit(workspace.id, snapshot)}
        {...(ready ? { onOpenRepository: () => openHistory(workspace.id, ready.snapshot, history.reference) } : {})} />}
    </div>
  </div>)
}

/** Ordinary Projects consume their files and Git, without a Scratch directory subscription. */
export function ProjectFilesTool({ workspace, visible, onOpenPath, onOpenTerminal, actions, content }: WorkspaceFileActions & { actions: ReactNode; content: ReactNode }) {
  return <WorkspaceFilesFrame workspace={workspace} visible={visible} presentation={contentSlotPresentation(false)}
    title={workspace.name} subtitle={workspace.branch} actions={actions}
    explorer={{ rootPath: '', rootLabel: workspace.name, onOpenPath, onOpenTerminal }}>{content}</WorkspaceFilesFrame>
}
