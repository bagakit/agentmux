import { SemanticIcon } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'

/** Locate the original Space selection in the same map; no local dialog or reading owner. */
export function WorkspaceCollaboration() {
  const open = useAppStore(state => state.openCollaborationMap)
  return <button type="button" aria-label="Locate current Agent in map" title="Locate in map" onClick={() => open()}><SemanticIcon name="action.locate" size={15} /></button>
}
