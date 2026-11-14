import type { WorkspaceRecord } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { useAppStore } from '../store'

export type FocusGroupLauncher = { workspaceId: string; groupId: string; tabId: string; regionId: string }

/** This operation prepares one original Launcher, never starts or replaces a Run. */
export function openFocusGroupAgentLauncher(project: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>, prompt: string, current: () => boolean): FocusGroupLauncher | undefined {
  if (!current()) return
  const state = useAppStore.getState(), matches = state.config?.workspaces.filter(workspace => workspace.id === project.id) ?? []
  const original = matches.length === 1 ? matches[0] : undefined
  // Reject only this unconfirmed creation target; existing Agents and their workfaces remain available.
  if (!original || original.id === SCRATCH_WORKSPACE_ID || original.hostId !== project.hostId || original.path !== project.path || original.closeout) {
    throw new Error('The selected project is no longer confirmed. The task and original workfaces are kept; choose its exact project again.')
  }
  const layout = state.prepareWorkbenchLayout(original.id)
  if (!current()) return
  const tabId = useAppStore.getState().openLauncher({ workspaceId: original.id, tabGroupId: layout.activeGroupId, reveal: true })
  const latest = useAppStore.getState(), tab = tabId ? latest.tabs[tabId] : undefined
  const surface = tab?.regions[tab.layout.activeRegionId]
  if (!tab || surface?.kind !== 'launcher' || surface.workspaceId !== original.id) {
    throw new Error('The project Launcher could not be confirmed. The task and existing work are kept; review the original project before trying again.')
  }
  // A newly created Region has its own draft; no warm Group input or existing Composer is consumed.
  latest.setAgentComposerDraft(surface.regionId, prompt)
  return { workspaceId: original.id, groupId: layout.activeGroupId, tabId: tab.id, regionId: surface.regionId }
}
