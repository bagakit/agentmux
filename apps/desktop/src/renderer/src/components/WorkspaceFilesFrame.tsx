import { ChevronDown, ChevronRight, RadioTower } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { resolveExplorerCollapsed, type ContentSlotPresentation } from '../lib/surface-tool-dock'
import { useAppStore } from '../store'
import { FileExplorer } from './FileExplorer'

export type WorkspaceFileActions = {
  workspace: WorkspaceRecord
  visible: boolean
  onOpenPath?: ((path: string) => Promise<unknown>) | undefined
  onOpenTerminal?: ((path: string) => Promise<unknown>) | undefined
}

/** Layout only. Domain owners supply their original file scope, actions and content. */
export function WorkspaceFilesFrame({ workspace, visible, presentation, title, subtitle, actions,
  explorer, explorerKey = workspace.id, fileIssue, children }: {
  workspace: WorkspaceRecord; visible: boolean; presentation: ContentSlotPresentation
  title: string; subtitle?: string | undefined; actions?: ReactNode
  explorer: Omit<ComponentProps<typeof FileExplorer>, 'active' | 'workspaceId' | 'toolbarTarget'>
  explorerKey?: string; fileIssue?: ReactNode; children: ReactNode
}) {
  const displayPath = usePathDisplay()
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null)
  const override = useAppStore(state => state.explorerCollapsed[workspace.id])
  const setExplorerCollapsed = useAppStore(state => state.setExplorerCollapsed)
  const collapsed = resolveExplorerCollapsed(override, presentation.explorerCollapsedByDefault)
  return <div className="workspace-tool-explorer">
    <div className="workspace-tool-context workspace-tool-context--collapsible workspace-tool-context--explorer">
      <button type="button" className="workspace-tool-context__toggle" aria-expanded={!collapsed}
        aria-label={collapsed ? 'Show file tree' : 'Hide file tree'} title={collapsed ? 'Show file tree' : 'Hide file tree'}
        onClick={() => setExplorerCollapsed(workspace.id, !collapsed)}>
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      </button>
      <span title={displayPath(workspace.path, workspace.hostId)}><strong>{title}</strong>{subtitle ? <small>{subtitle}</small> : null}</span>
      {workspace.hostId !== 'local' ? <em><RadioTower size={11} /> {workspace.hostId}</em> : null}
      <div className="workspace-tool-context__actions">{actions}<div ref={setToolbarTarget} /></div>
    </div>
    <PanelGroup direction="vertical" className={collapsed ? 'workspace-tools-collapsed' : 'workspace-tools-split'}
      key={presentation.showTopics ? 'content-slot-topics' : 'content-slot-branches'}>
      {/* Store is the sole collapse owner. Hiding the file panel keeps the content
          in its original parent without a second library collapse state. */}
      <Panel defaultSize={presentation.fileTreeDefaultSize} minSize={presentation.fileTreeMinSize}
        style={collapsed ? { display: 'none' } : undefined} aria-hidden={collapsed}>
        {!collapsed ? fileIssue ?? <FileExplorer {...explorer} key={explorerKey} active={visible} workspaceId={workspace.id} toolbarTarget={toolbarTarget} /> : null}
      </Panel>
      {!collapsed ? <PanelResizeHandle className="workspace-tools-resize-handle" /> : null}
      <Panel defaultSize={100 - presentation.fileTreeDefaultSize} minSize={20}>{children}</Panel>
    </PanelGroup>
  </div>
}
