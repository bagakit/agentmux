import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../../src/shared/contracts'
import { directoryIdentity, workspaceZoneId } from '../../src/shared/space-addresses'
import { createWorkbenchTab } from '../../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../../src/renderer/src/lib/space-agent-control'
import { reconcileOriginalSourceProjection, originalSourceWorkspaceId, originalSourceTabProjectionId } from '../../src/renderer/src/lib/original-space-navigation'

/** Same original IDs observed through either this Runtime or another Runtime. */
export function spaceNewTabFixture(config: AppConfig, agent: Extract<SessionSnapshot, { kind: 'agent' }>, runtimeId: string) {
  const workspace = config.workspaces[0]!
  const session = { ...agent, workspacePath: workspace.path }
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached',
    regionId: 'original-region', workspaceId: workspace.id, sessionId: session.id })
  const spaceId = directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path)
  const zoneId = workspaceZoneId(spaceId, workspace.id)
  tab.space = { spaceId, zoneId }
  const selection = { spaceId, zoneId, workspaceId: workspace.id, topicId: null,
    tabId: tab.id, groupId: 'original-group', regionId: tab.layout.activeRegionId }
  const base = { config, sessions: [session], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) },
    spaceZoneBindings: {}, spatialRequests: {}, mountedSpaceInputs: {}, activeWorkspaceId: workspace.id, workbenchSpaceSelection: selection }
  const catalog = spatialCatalog(base, [])
  const target = { hostId: workspace.hostId, reference: { runtimeId, spaceId }, zoneId, workspaceId: workspace.id }
  const scope = { space: catalog.spaces.find(space => space.spaceId === spaceId)!,
    zones: catalog.zones, tabs: catalog.tabs, regions: catalog.regions, bindings: catalog.bindings }
  const projected = reconcileOriginalSourceProjection(base, target, { scope })
  return { state: { ...base, ...projected }, session, tab, zoneId, spaceId, target,
    sourceWorkspaceId: originalSourceWorkspaceId(target), sourceTabId: originalSourceTabProjectionId(target, tab.id) }
}
