import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { AgentCollaborationDialog, type CollaborationRequest } from './AgentCollaborationDialog'

const CollaborationOpen = createContext<(() => void) | null>(null)

/** The reading owner survives keyed list resets below it. */
export function WorkspaceCollaborationScope({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [request, setRequest] = useState<CollaborationRequest | null>(null)
  const active = useWorkbenchPresentationActive()
  useEffect(() => { if (!active) setRequest(null) }, [active])
  const open = () => {
    const choice = useAppStore.getState().workbenchSpaceSelection
    setRequest({ kind: 'space', workspaceId, choice: choice ? { ...choice } : null })
  }
  return <CollaborationOpen.Provider value={open}>
    {children}
    <AgentCollaborationDialog request={request} onClose={() => setRequest(null)} onOpen={(context, reference) => useAppStore.getState().focusExecutionSession(context.id, reference)} />
  </CollaborationOpen.Provider>
}

/** Internal entry under the stable Space reading owner. */
export function WorkspaceCollaboration() {
  const open = useContext(CollaborationOpen)!
  return <button type="button" aria-label="Open area collaboration graph" title="Collaboration" onClick={open}><SemanticIcon name="object.collaboration" size={15} /></button>
}
