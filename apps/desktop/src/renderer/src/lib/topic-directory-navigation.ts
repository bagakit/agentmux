import type { WorkspaceRecord } from '../../../shared/contracts'
import { directoryIdentity } from '../../../shared/space-addresses'
import { useAppStore } from '../store'

/** The original Topics heading and Settings discover the same directory workface. */
export async function openTopicDirectory(workspace: WorkspaceRecord): Promise<void> {
  const preparing = useAppStore.getState().selectWorkspace(workspace.id)
  useAppStore.setState({
    workbenchSpaceSelection: { spaceId: directoryIdentity(workspace.hostId, workspace.path), zoneId: null,
      workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null },
    workspaceTool: 'files-branches', toolsOpen: true
  })
  await preparing
}
