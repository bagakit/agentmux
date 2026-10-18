import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { resolveExplorerCollapsed, type ContentSlotPresentation } from '../lib/surface-tool-dock'
import { useAppStore } from '../store'
import { FileExplorer } from './FileExplorer'

const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeObjectHostIcon = semanticIconComponent('object.host')


export type WorkspaceFileActions = {
  workspace: WorkspaceRecord
  visible: boolean
  onOpenPath?: ((path: string) => Promise<unknown>) | undefined
  onOpenTerminal?: ((path: string) => Promise<unknown>) | undefined
}

/** Layout only. Domain owners supply their original file scope, actions and content. */
export function WorkspaceFilesFrame({ workspace, visible, presentation, title, subtitle, actions,
  explorer, explorerKey = workspace.id, fileIssue, children, directoryFirst = false, contextPath = workspace.path, showExplorer = true }: {
  workspace: WorkspaceRecord; visible: boolean; presentation: ContentSlotPresentation
  title: string; subtitle?: string | undefined; actions?: ReactNode
  explorer: Omit<ComponentProps<typeof FileExplorer>, 'active' | 'workspaceId' | 'toolbarTarget'>
  explorerKey?: string; fileIssue?: ReactNode; children: ReactNode
  directoryFirst?: boolean; contextPath?: string | undefined; showExplorer?: boolean
}) {
  const displayPath = usePathDisplay()
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null)
  const override = useAppStore(state => state.explorerCollapsed[workspace.id])
  const setExplorerCollapsed = useAppStore(state => state.setExplorerCollapsed)
  const collapsed = resolveExplorerCollapsed(override, presentation.explorerCollapsedByDefault)
  const context = <div className="workspace-tool-context workspace-tool-context--collapsible workspace-tool-context--explorer" hidden={!showExplorer}>
      <button type="button" className={`workspace-tool-context__toggle${directoryFirst ? ' workspace-tool-context__toggle--label' : ''}`} aria-expanded={!collapsed}
        aria-label={collapsed ? 'Show file tree' : 'Hide file tree'} title={collapsed ? 'Show file tree' : 'Hide file tree'}
        onClick={() => setExplorerCollapsed(workspace.id, !collapsed)}>
        {collapsed ? <ThemeNavigationDisclosureIcon size={13} /> : <ThemeNavigationDownIcon size={13} />}
        {directoryFirst ? <strong>{title}</strong> : null}
      </button>
      <span title={displayPath(contextPath, workspace.hostId)}>{!directoryFirst ? <strong>{title}</strong> : null}{subtitle ? <small>{subtitle}</small> : null}</span>
      {workspace.hostId !== 'local' ? <em><ThemeObjectHostIcon size={11} /> {workspace.hostId}</em> : null}
      <div className="workspace-tool-context__actions">{actions}<div ref={setToolbarTarget} /></div>
    </div>
  const content = <Panel key="content" defaultSize={100 - presentation.fileTreeDefaultSize} minSize={directoryFirst ? 55 : 20}>{children}</Panel>
  const fileContent = !collapsed ? fileIssue ?? <FileExplorer {...explorer} key={explorerKey} active={visible && showExplorer} workspaceId={workspace.id} toolbarTarget={toolbarTarget} /> : null
  const files = <Panel key="files" defaultSize={presentation.fileTreeDefaultSize} minSize={presentation.fileTreeMinSize}
    maxSize={directoryFirst ? 45 : undefined} className={directoryFirst ? 'workspace-topic-files' : undefined}
    style={!showExplorer ? { display: 'none' } : collapsed ? directoryFirst ? { flexGrow: 0, flexShrink: 0, flexBasis: 'var(--topic-files-header-height)' } : { display: 'none' } : undefined}
    aria-hidden={!showExplorer || collapsed && !directoryFirst}>
    {directoryFirst ? context : null}
    {directoryFirst ? <div className="workspace-topic-files__content">{fileContent}</div> : fileContent}
  </Panel>
  return <div className={`workspace-tool-explorer${directoryFirst ? ' workspace-tool-explorer--directory-first' : ''}${!showExplorer ? ' workspace-tool-explorer--content-only' : ''}`}>
    {!directoryFirst ? context : null}
    <PanelGroup direction="vertical" className={collapsed ? 'workspace-tools-collapsed' : 'workspace-tools-split'}
      key={presentation.showTopics ? 'content-slot-topics' : 'content-slot-branches'}>
      {/* Page visibility leaves the original panel and file instance in place.
          Only the existing explicit collapse preference controls tree mounting. */}
      {directoryFirst ? content : files}
      {showExplorer && !collapsed ? <PanelResizeHandle className="workspace-tools-resize-handle" /> : null}
      {directoryFirst ? files : content}
    </PanelGroup>
  </div>
}
