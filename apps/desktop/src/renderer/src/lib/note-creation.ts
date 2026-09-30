import type { AppConfig, WorkspaceFileWriteResult } from '../../../shared/contracts'
import type { FileOpenPlacement } from './file-workbench-state'
import type { WorkbenchEntityReference, WorkbenchProjection, WorkbenchProjectionSelection } from './workbench-projection'
export type NoteCreationTarget = {
  workspaceId: string
  hostId: string
  workspacePath: string
  directoryPath: string | null
  relativeDirectory: string | null
  zoneId: string | null
  sourceSpaceId: string | null
  displayWorkspaceId: string | null
  groupId: string
}
/** Original Launcher draft's operation receipt, never a second canonical document. */
export type NoteCreationReceipt = {
  intentId: string
  createdAt: number
  noteId: string
  blockIds: string[]
  draft: string
  target: NoteCreationTarget
  path: string
  status: 'pending' | 'written' | 'unknown' | 'error'
  write?: Exclude<WorkspaceFileWriteResult, { status: 'conflict' }>
  revealed: boolean
  presentation?: { presentationId: string; entity: WorkbenchEntityReference; reference: WorkbenchProjectionSelection }
  launcher?: { tabId: string; regionId: string }
  issue?: string | undefined
}

import type { ScratchTopicSnapshot } from '../../../shared/scratch-topics'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { directoryIdentity, homeZoneId, workspaceZoneId } from '../../../shared/space-addresses'
import { spatialCatalog, zoneContext } from './space-agent-control'
import { zoneFileResource } from './zone-file-resource'
import { groupIds } from '@agentmux/layout'

export function noteCreationResourceMatches(config: AppConfig | null, target: NoteCreationTarget): boolean {
  const workspace = config?.workspaces.find(item => item.id === target.workspaceId)
  return workspace?.hostId === target.hostId && workspace.path === target.workspacePath
}

export function noteFilePlacement(target: NoteCreationTarget, projection?: WorkbenchProjection): FileOpenPlacement | null {
  return target.zoneId && target.sourceSpaceId && target.displayWorkspaceId ? {
    displayWorkspaceId: target.displayWorkspaceId, space: { spaceId: target.sourceSpaceId, zoneId: target.zoneId },
    resource: { hostId: target.hostId, path: target.workspacePath }, ...(projection ? { projection } : {})
  } : null
}

/** Resolve physical occurrence only; missing or multiple occurrences stay unknown. */
export function noteCreationDisplayWorkspace(state: Parameters<typeof spatialCatalog>[0], input: {
  workspaceId: string; groupId: string; displayWorkspaceId?: string; launcher?: { tabId: string; regionId: string }
}): string | null {
  const tab = input.launcher ? state.tabs[input.launcher.tabId] : undefined
  if (input.launcher && (tab?.workspaceId !== input.workspaceId || !tab.regions[input.launcher.regionId])) return null
  const candidates = Object.entries(state.layouts).filter(([workspaceId, layout]) =>
    (input.displayWorkspaceId ? workspaceId === input.displayWorkspaceId : input.launcher || workspaceId === input.workspaceId) && groupIds(layout.root).includes(input.groupId) &&
    layout.groups.some(group => group.id === input.groupId && (!input.launcher || group.tabOrder.includes(input.launcher.tabId))))
  return candidates.length === 1 ? candidates[0]![0] : null
}

/** Consume the original Zone birth context; Topic display relations never select a file directory. */
export function noteCreationTarget(state: Parameters<typeof spatialCatalog>[0], topics: readonly ScratchTopicSnapshot[], input: {
  workspaceId: string; groupId: string; displayWorkspaceId?: string; launcher?: { tabId: string; regionId: string }
}): NoteCreationTarget {
  const workspace = state.config?.workspaces.find(item => item.id === input.workspaceId)
  if (!workspace) throw new Error('The Note resource Workspace is unavailable.')
  const catalog = spatialCatalog(state, topics)
  const tab = input.launcher ? catalog.tabs.find(item => item.tabId === input.launcher!.tabId && item.regionIds.includes(input.launcher!.regionId)) : undefined
  if (input.launcher && (!tab || tab.workspaceId !== workspace.id)) throw new Error('The exact Note Launcher resource cannot be confirmed.')
  const displayWorkspaceId = noteCreationDisplayWorkspace(state, input)
  if (!displayWorkspaceId) throw new Error('The Note Launcher display location is missing or ambiguous; choose the exact location.')
  const layout = state.layouts[displayWorkspaceId]
  if (!layout || !groupIds(layout.root).includes(input.groupId) || !layout.groups.some(group => group.id === input.groupId)) throw new Error('The Note display Group is unavailable.')
  const defaultZoneId = workspace.id === SCRATCH_WORKSPACE_ID ? homeZoneId(directoryIdentity(workspace.hostId, workspace.path)) : workspaceZoneId(directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path), workspace.id)
  const zone = catalog.zones.find(item => item.zoneId === (tab?.zoneId ?? defaultZoneId))
  if (!zone || zone.kind === 'unknown' || zone.workspaceId !== workspace.id || zone.hostId !== workspace.hostId || !zone.directoryPath) throw new Error('The Note Zone birth directory is unknown. Its draft and original target are retained.')
  const sourceSpaceId = zoneContext(state, topics, zone)
  const { directoryPath, relativeDirectory } = zoneFileResource(workspace, zone)
  return { workspaceId: workspace.id, hostId: workspace.hostId, workspacePath: workspace.path, directoryPath, relativeDirectory, zoneId: zone.zoneId, sourceSpaceId, displayWorkspaceId, groupId: input.groupId }
}
