import { useRef, useState } from 'react'
import { useMoteMaterialsActions } from '../lib/mote-materials-actions'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { contentSlotPresentation } from '../lib/surface-tool-dock'
import { useAppStore } from '../store'
import { scratchTopicPhysicalPath } from '../../../shared/scratch-topics'
import { MoteDetailsPanel } from './MoteDetailsPanel'
import { WorkspaceFilesFrame, type WorkspaceFileActions } from './WorkspaceFilesFrame'

/** Mote material operations retain their original owner and exact display reference. */
export function MoteFilesTool({ visible, isScratch, scope, reference, onOpenPath, onOpenTerminal }: WorkspaceFileActions & {
  isScratch: boolean; scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
}) {
  const materials = useMoteMaterialsActions(scope)
  const [createRequest, setCreateRequest] = useState<{ requestId: number; parentPath: string }>()
  const requestId = useRef(0)
  return <WorkspaceFilesFrame workspace={scope.workspace} visible={visible} presentation={contentSlotPresentation(isScratch, scope)} title={scope.topic.title}
    contextPath={scratchTopicPhysicalPath(scope.workspace, scope.topic)}
    explorerKey={scope.workspace.id + scope.topic.id} explorer={{ rootPath: scope.rootPath, rootLabel: scope.topic.title,
      createRequest, onCreateRequestHandled: () => setCreateRequest(undefined), onOpenPath: onOpenPath ?? materials.open, onOpenTerminal: onOpenTerminal ?? materials.terminal }}>
    <div className="workspace-tool-slot" style={{ height: '100%' }}>
    {scope.issue ? <div className="surface-inline-error" role="status" aria-label="Mote directory observation"
      style={{ flexShrink: 0, maxHeight: '40%', overflowY: 'auto' }}>{scope.issue} Existing files and Mote content remain available.
      <button type="button" className="small-button" aria-label="Retry Mote directory discovery" onClick={() => {
        void useAppStore.getState().refreshScratchTopics(scope.workspace.id, true).catch(error => useAppStore.getState().reportError(error))
      }}>Retry directory discovery</button>
    </div> : null}
    <div className="workspace-tool-slot"><MoteDetailsPanel key={scope.topic.id} scope={scope} reference={reference} active={visible} onOpenPath={onOpenPath ?? materials.open}
      onCreateNote={() => {
        useAppStore.getState().setExplorerCollapsed(scope.workspace.id, false)
        setCreateRequest({ requestId: ++requestId.current, parentPath: scope.rootPath })
      }} /></div>
    </div>
  </WorkspaceFilesFrame>
}
