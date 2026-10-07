import type { ReactNode } from 'react'
import { contentSlotPresentation } from '../lib/surface-tool-dock'
import { useWorkspaceZoneContext } from '../lib/workspace-zone-context'
import { openWorkspaceZoneFile, openWorkspaceZoneTerminal } from '../lib/workspace-zone-file-actions'
import { useAppStore } from '../store'
import { WorkspaceZonesPanel } from './WorkspaceZonesPanel'
import { WorkspaceChangesSummary } from './WorkspaceGitTool'
import { WorkspaceFilesFrame, type WorkspaceFileActions } from './WorkspaceFilesFrame'

export function ProjectFilesTool({ workspace, visible, onOpenPath, onOpenTerminal, actions }: WorkspaceFileActions & { actions: ReactNode }) {
  const context = useWorkspaceZoneContext(workspace)
  const openGit = (view: 'changes' | 'branches') => {
    useAppStore.getState().setWorkspaceGitView(view)
    useAppStore.getState().setWorkspaceTool('git')
  }
  const zones = <WorkspaceZonesPanel workspace={workspace} visible={visible} onCreateWorktree={() => openGit('branches')} />
  if (!context.files) return <div className="workspace-tool-explorer">
    <div className="surface-inline-error" role="status">{context.issue}</div>
    {zones}
  </div>
  const files = context.files
  return <WorkspaceFilesFrame workspace={files.workspace} visible={visible} presentation={contentSlotPresentation(false)}
    title={files.workspace.name} subtitle={files.workspace.branch} contextPath={files.directoryPath} actions={actions}
    explorer={{ rootPath: files.rootPath, rootLabel: files.workspace.name,
      onOpenPath: onOpenPath ?? (path => openWorkspaceZoneFile(workspace, path)),
      onOpenTerminal: onOpenTerminal ?? (path => openWorkspaceZoneTerminal(workspace, path)) }}>
    <div className="workspace-zone-content">
      {context.resource ? <WorkspaceChangesSummary workspace={context.resource} active={visible} onOpen={() => openGit('changes')} />
        : <div className="surface-inline-error" role="status">{context.issue}</div>}
      {zones}
    </div>
  </WorkspaceFilesFrame>
}
