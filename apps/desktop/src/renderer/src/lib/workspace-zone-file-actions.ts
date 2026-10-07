import { groupIds } from '@agentmux/layout'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { zoneFileResource } from '../../../shared/zone-file-resource'
import { useAppStore } from '../store'
import { fileExplorerContains } from './file-explorer-scope'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { workspaceZoneContext } from './workspace-zone-context'

function fileTarget(displayWorkspace: WorkspaceRecord, workspaceRelativePath: string) {
  const state = useAppStore.getState(), context = workspaceZoneContext(state, displayWorkspace)
  const files = context.files, zone = context.zones.find(zone => zone.zoneId === context.selectedZoneId)
  if (!files || !zone) throw new Error(context.issue ?? 'The original Zone Files scope is unconfirmed. Choose its original Zone and retry.')
  if (!fileExplorerContains(files.rootPath, workspaceRelativePath)) throw new Error('The requested Workspace path is outside the selected Zone Files scope. Choose a file or directory inside this Zone.')
  const path = files.rootPath ? workspaceRelativePath === files.rootPath ? '.' : workspaceRelativePath.slice(files.rootPath.length + 1) : workspaceRelativePath
  const mapped = zoneFileResource(files.workspace, zone, path, scratchTopicsForWorkspace(state.scratchTopicSnapshots, files.workspace) ?? [])
  if (mapped.path !== workspaceRelativePath) throw new Error('The original Workspace path does not match the Zone file mapping. Refresh this Zone and choose the exact path.')
  const choice = state.workbenchSpaceSelection
  const selected = choice?.spaceId === context.spaceId && choice.zoneId === zone.zoneId ? choice : null
  const displayWorkspaceId = selected?.workspaceId ?? displayWorkspace.id
  const layout = state.layouts[displayWorkspaceId]
  const groupId = selected?.groupId ?? layout?.activeGroupId
  if (!layout || !groupId || !groupIds(layout.root).includes(groupId) || !layout.groups.some(group => group.id === groupId)) {
    throw new Error('The exact Zone display Group is unavailable. Its original workface is kept; restore or select its original Group and retry.')
  }
  return { state, context, files, zone, path, displayWorkspaceId, groupId }
}

export async function openWorkspaceZoneFile(displayWorkspace: WorkspaceRecord, workspaceRelativePath: string, mode?: 'diff'): Promise<void> {
  try {
    const target = fileTarget(displayWorkspace, workspaceRelativePath)
    const result = await target.state.executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'open.file',
      spaceId: target.context.spaceId, zoneId: target.zone.zoneId, path: target.path,
      displayWorkspaceId: target.displayWorkspaceId, groupId: target.groupId, focus: true }, undefined,
      { fileOpenIntent: mode === 'diff' ? 'source' : 'default', fileInputPolicy: 'target' })
    if (result.operation !== 'open.file') throw new Error('The original File owner returned an unexpected receipt. Inspect the original request before retrying.')
    if (result.issues.length) useAppStore.getState().reportError(new Error(`Open Zone file ${workspaceRelativePath}: ${result.issues.map(issue => `${issue.code}: ${issue.message} ${issue.recovery}`).join('\n')}`))
    if (result.placement.status !== 'created' && result.placement.status !== 'reused' ||
      !result.placement.tabId || !result.placement.regionId || result.outcome === 'refused' || result.outcome === 'unknown') {
      if (!result.issues.length) throw new Error('The exact Zone File placement was not confirmed. Inspect its original request; do not open another Zone as a substitute.')
      return
    }
    if (result.navigation !== 'applied') {
      if (!result.issues.length) throw new Error('The Zone File navigation was not applied. Its original data and later user navigation are kept.')
      return
    }
    if (mode === 'diff') {
      const current = useAppStore.getState(), tab = current.tabs[result.placement.tabId]
      const surface = tab?.regions[result.placement.regionId]
      const workspace = current.config?.workspaces.find(workspace => workspace.id === target.files.workspace.id)
      if (result.resource?.zoneId !== target.zone.zoneId || result.resource.workspaceId !== target.files.workspace.id ||
        result.resource.hostId !== target.files.workspace.hostId || result.resource.workspacePath !== target.files.workspace.path ||
        result.resource.path !== workspaceRelativePath || !result.placement.locations.some(location => location.spaceId === target.context.spaceId &&
          location.zoneId === target.zone.zoneId && location.displayWorkspaceId === target.displayWorkspaceId && location.groupId === target.groupId &&
          location.tabId === result.placement.tabId && location.regionId === result.placement.regionId) ||
        surface?.kind !== 'file' || surface.workspaceId !== target.files.workspace.id || surface.path !== workspaceRelativePath ||
        tab?.space?.zoneId !== target.zone.zoneId || workspace?.hostId !== target.files.workspace.hostId || workspace.path !== target.files.workspace.path) {
        throw new Error('The returned Zone File Region or its original resource changed. Later work is kept; inspect that exact Region before requesting Diff again.')
      }
      await current.setEditorRegionMode(result.placement.regionId, target.files.workspace.id, workspaceRelativePath, 'diff')
    }
  } catch (error) { useAppStore.getState().reportError(new Error(`Open Zone file ${workspaceRelativePath}: ${error instanceof Error ? error.message : String(error)}`)) }
}

export async function openWorkspaceZoneTerminal(displayWorkspace: WorkspaceRecord, workspaceRelativePath: string): Promise<void> {
  try {
    const target = fileTarget(displayWorkspace, workspaceRelativePath)
    const tabId = target.state.openLauncher({ workspaceId: target.files.workspace.id, displayWorkspaceId: target.displayWorkspaceId,
      tabGroupId: target.groupId, zoneId: target.zone.zoneId, reveal: true })
    const current = useAppStore.getState(), tab = tabId ? current.tabs[tabId] : undefined
    const regionId = tab?.layout.activeRegionId
    if (!tab || !regionId || tab.space?.zoneId !== target.zone.zoneId || tab.regions[regionId]?.kind !== 'launcher' ||
      !current.layouts[target.displayWorkspaceId]?.groups.find(group => group.id === target.groupId)?.tabOrder.includes(tab.id)) {
      throw new Error('The original Zone Terminal Launcher was not confirmed. Inspect this Zone and its exact display Group before retrying.')
    }
    const directoryPath = target.path === '.' || target.path === '' ? target.files.directoryPath
      : `${target.files.directoryPath.replace(/\/+$/, '')}/${target.path}`
    await current.launchTerminal(target.groupId, { tabId: tab.id, regionId }, directoryPath)
  } catch (error) { useAppStore.getState().reportError(new Error(`Open Zone terminal ${workspaceRelativePath}: ${error instanceof Error ? error.message : String(error)}`)) }
}
