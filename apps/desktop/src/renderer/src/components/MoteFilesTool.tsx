import { useRef, useState } from 'react'
import { useMoteMaterialsActions } from '../lib/mote-materials-actions'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { contentSlotPresentation } from '../lib/surface-tool-dock'
import { useAppStore } from '../store'
import { MoteDetailsPanel } from './MoteDetailsPanel'
import { WorkspaceFilesFrame, type WorkspaceFileActions } from './WorkspaceFilesFrame'

/** Mote material operations retain their original owner and exact display reference. */
export function MoteFilesTool({ workspace, visible, isScratch, scope, reference, onOpenPath, onOpenTerminal }: WorkspaceFileActions & {
  isScratch: boolean; scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
}) {
  const materials = useMoteMaterialsActions(scope)
  const [createRequest, setCreateRequest] = useState<{ requestId: number; parentPath: string }>()
  const requestId = useRef(0)
  return <WorkspaceFilesFrame workspace={workspace} visible={visible} presentation={contentSlotPresentation(isScratch)} title={scope.topic.title}
    explorerKey={workspace.id + scope.topic.id} explorer={{ rootPath: scope.rootPath, rootLabel: scope.topic.title,
      createRequest, onCreateRequestHandled: () => setCreateRequest(undefined), onOpenPath: onOpenPath ?? materials.open, onOpenTerminal: onOpenTerminal ?? materials.terminal }}>
    <MoteDetailsPanel key={scope.topic.id} scope={scope} reference={reference} active={visible} onOpenPath={onOpenPath ?? materials.open}
      onCreateNote={() => {
        useAppStore.getState().setExplorerCollapsed(workspace.id, false)
        setCreateRequest({ requestId: ++requestId.current, parentPath: scope.rootPath })
      }} />
  </WorkspaceFilesFrame>
}
