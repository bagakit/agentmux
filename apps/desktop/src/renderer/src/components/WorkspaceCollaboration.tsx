import { useEffect, useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { AgentCollaborationDialog, type CollaborationRequest } from './AgentCollaborationDialog'

/** An attached read surface. Opening it does not change Space or execution focus. */
export function WorkspaceCollaboration({ workspaceId }: { workspaceId: string }) {
  const [request, setRequest] = useState<CollaborationRequest | null>(null)
  const active = useWorkbenchPresentationActive()
  useEffect(() => { if (!active) setRequest(null) }, [active])
  return <>
    <button type="button" aria-label="Open area collaboration graph" title="Collaboration" onClick={() => {
      const choice = useAppStore.getState().workbenchSpaceSelection
      setRequest({ kind: 'space', workspaceId, choice: choice ? { ...choice } : null })
    }}><SemanticIcon name="object.collaboration" size={15} /></button>
    <AgentCollaborationDialog request={request} onClose={() => setRequest(null)} onOpen={(context, reference) => useAppStore.getState().focusExecutionSession(context.id, reference)} />
  </>
}
