import { useState, type ReactNode } from 'react'
import { useGitHistory } from '../hooks/useGitHistory'
import { contentSlotPresentation } from '../lib/surface-tool-dock'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { BranchesPanel } from './BranchesPanel'
import { ChangesPanel } from './ChangesPanel'
import { GitHistoryPanel } from './GitHistoryPanel'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { WorkspaceFilesFrame, type WorkspaceFileActions } from './WorkspaceFilesFrame'

type ProjectView = 'branches' | 'changes' | 'history'
const VIEWS = [{ value: 'branches', label: 'Branches' }, { value: 'changes', label: 'Changes' }, { value: 'history', label: 'History' }] as const

/** Git state stays above the collapsible frame, so completed history pages survive it. */
export function ProjectSourceControl({ workspace, visible, children }: {
  workspace: WorkspaceRecord; visible: boolean; children(content: ReactNode): ReactNode
}) {
  const [view, setView] = useState<ProjectView>('branches')
  const history = useGitHistory(workspace, visible && view === 'history')
  return children(<div className="content-slot-source-control">
    <SurfaceModeSwitch value={view} options={VIEWS} onChange={setView} active={visible} ariaLabel="Source control view" />
    {view === 'branches' && <BranchesPanel workspace={workspace} />}
    {view === 'changes' && <ChangesPanel workspace={workspace} />}
    <div className="source-control-history" hidden={view !== 'history'}><GitHistoryPanel workspace={workspace} history={history} /></div>
  </div>)
}

/** Ordinary Projects consume their files and Git, without a Scratch directory subscription. */
export function ProjectFilesTool({ workspace, visible, onOpenPath, onOpenTerminal, actions, content }: WorkspaceFileActions & { actions: ReactNode; content: ReactNode }) {
  return <WorkspaceFilesFrame workspace={workspace} visible={visible} presentation={contentSlotPresentation(false)}
    title={workspace.name} subtitle={workspace.branch} actions={actions}
    explorer={{ rootPath: '', rootLabel: workspace.name, onOpenPath, onOpenTerminal }}>{content}</WorkspaceFilesFrame>
}
