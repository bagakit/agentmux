import { SemanticIcon } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'

/** A secondary Space action locates its exact original context in the retained Focus map. */
export function WorkspaceCollaboration() {
  const locate = useAppStore(state => state.locateSpaceInCollaborationMap)
  return <button type="button" aria-label="Locate Space in Focus map" title="Locate current Space in Focus map" onClick={locate}><SemanticIcon name="action.locate" size={15} /></button>
}
