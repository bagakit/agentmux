import type { AgentMuxSpaceCatalog, AgentMuxZoneFact } from '@agentmux/core/control'
import { useMemo } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { workspaceZoneId } from '../../../shared/space-addresses'
import { zoneFileResource } from '../../../shared/zone-file-resource'
import { useAppStore } from '../store'
import { workbenchSelectionCatalog, type NavigationState } from './desktop-focus-navigation'
import { workspaceProjectId } from './workspace-projects'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'

export type WorkspaceZoneFilesScope = { workspace: WorkspaceRecord; rootPath: string; directoryPath: string }

export type WorkspaceZoneContext = {
  spaceId: string
  zones: AgentMuxZoneFact[]
  selectedZoneId: string | null
  resource: WorkspaceRecord | null
  files: WorkspaceZoneFilesScope | null
  issue: string | null
}

const contexts = new WeakMap<WorkspaceRecord, { catalog: AgentMuxSpaceCatalog; explicitZoneId: string | null; value: WorkspaceZoneContext }>()

export function workspaceZoneContext(state: NavigationState, workspace: WorkspaceRecord): WorkspaceZoneContext {
  const catalog = workbenchSelectionCatalog(state)
  const projectSpaceId = workspaceProjectId(workspace)
  const selected = state.workbenchSpaceSelection
  const choice = selected?.workspaceId === workspace.id || selected?.spaceId === projectSpaceId ? selected : null
  const spaceId = choice?.spaceId ?? projectSpaceId
  const explicitZoneId = choice?.zoneId ?? null
  const previous = contexts.get(workspace)
  if (previous?.catalog === catalog && previous.value.spaceId === spaceId && previous.explicitZoneId === explicitZoneId) {
    return previous.value
  }
  const bound = new Set(catalog.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
  const zones = catalog.zones.filter(zone => bound.has(zone.zoneId))
  const defaultZoneId = workspaceZoneId(projectSpaceId, workspace.id)
  const selectedZoneId = explicitZoneId ?? zones.find(zone => zone.zoneId === defaultZoneId)?.zoneId ?? null
  let resource: WorkspaceRecord | null = workspace
  let files: WorkspaceZoneFilesScope | null = { workspace, rootPath: '', directoryPath: workspace.path }
  let issue: string | null = null
  if (explicitZoneId !== null) {
    const zone = zones.find(zone => zone.zoneId === explicitZoneId)
    const original = zone && state.config?.workspaces.find(value => value.id === zone.workspaceId)
    if (!zone || zone.kind === 'unknown' || zone.hostId === null || zone.directoryPath === null || !original) {
      resource = null
      files = null
      issue = `${zone?.issue ?? 'The selected Zone resource is unconfirmed; its identity and workface are kept.'} Restore its original Workspace or choose another Zone.`
    } else {
      try {
        const mapped = zoneFileResource(original, zone, '', scratchTopicsForWorkspace(state.scratchTopicSnapshots, original) ?? [])
        files = { workspace: original, rootPath: mapped.relativeDirectory, directoryPath: mapped.directoryPath }
        if (original.hostId !== zone.hostId || original.path !== zone.directoryPath) {
          resource = null
          issue = `Git scope is unsupported for this Zone directory within registered Workspace ${original.id}. Files remain available in the confirmed Zone scope; choose an exact registered directory for Git operations.`
        } else resource = original
      } catch (error) {
        resource = null
        files = null
        issue = `${error instanceof Error ? error.message : String(error)} The original workface is kept; restore this Zone's confirmed Files scope or choose another Zone.`
      }
    }
  }
  const value = { spaceId, zones, selectedZoneId, resource, files, issue }
  contexts.set(workspace, { catalog, explicitZoneId, value })
  return value
}

export function useWorkspaceZoneContext(workspace: WorkspaceRecord): WorkspaceZoneContext {
  const select = useMemo(() => (state: NavigationState) => workspaceZoneContext(state, workspace), [workspace])
  return useAppStore(select)
}
