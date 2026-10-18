import { useCallback, useRef, useState } from 'react'
import { useMoteMaterialsActions } from '../lib/mote-materials-actions'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { contentSlotPresentation } from '../lib/surface-tool-dock'
import { useAppStore } from '../store'
import { scratchTopicPhysicalPath } from '../../../shared/scratch-topics'
import { MoteDetailsPanel } from './MoteDetailsPanel'
import { WorkspaceFilesFrame, type WorkspaceFileActions } from './WorkspaceFilesFrame'
import { useSpaceContentPresentation } from '../lib/space-content-presentation'

/** Mote material operations retain their original owner and exact display reference. */
export function MoteFilesTool({ visible, isScratch, scope, reference, onOpenPath, onOpenTerminal }: WorkspaceFileActions & {
  isScratch: boolean; scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
}) {
  const materials = useMoteMaterialsActions(scope)
  const presentation = useSpaceContentPresentation()
  const originalOpen = onOpenPath ?? materials.open
  const open = useCallback(async (path: string) => {
    const result = await originalOpen(path)
    if (result) presentation?.collapse()
    return result
  }, [originalOpen, presentation?.collapse])
  const [createRequest, setCreateRequest] = useState<{ requestId: number; parentPath: string }>()
  const requestId = useRef(0)
  return <WorkspaceFilesFrame workspace={scope.workspace} visible={visible} presentation={contentSlotPresentation(isScratch, scope)} title={scope.topic.title}
    showExplorer={!presentation?.expanded}
    contextPath={scratchTopicPhysicalPath(scope.workspace, scope.topic)}
    explorerKey={scope.workspace.id + scope.topic.id} explorer={{ rootPath: scope.rootPath, rootLabel: scope.topic.title,
      createRequest, onCreateRequestHandled: () => setCreateRequest(undefined), onOpenPath: open, onOpenTerminal: onOpenTerminal ?? materials.terminal }}>
    <div className="workspace-tool-slot" style={{ height: '100%' }}>
    {scope.issue ? <div className="surface-inline-error" role="status" aria-label="Mote directory observation"
      style={{ flexShrink: 0, maxHeight: '40%', overflowY: 'auto' }}>{scope.issue} Existing files and Mote content remain available.
      <button type="button" className="small-button" aria-label="Retry Mote directory discovery" onClick={() => {
        void useAppStore.getState().refreshScratchTopics(scope.workspace.id, true).catch(error => useAppStore.getState().reportError(error))
      }}>Retry directory discovery</button>
    </div> : null}
    <div className="workspace-tool-slot"><MoteDetailsPanel key={scope.topic.id} scope={scope} reference={reference} active={visible} onOpenPath={open}
      onCreateNote={() => {
        const state = useAppStore.getState()
        state.setExplorerCollapsed(scope.workspace.id, false)
        if (!state.toolsOpen) state.toggleTools()
        presentation?.collapse()
        setCreateRequest({ requestId: ++requestId.current, parentPath: scope.rootPath })
      }} /></div>
    </div>
  </WorkspaceFilesFrame>
}
