import { regionIds } from '@agentmux/layout'
import type { AgentMuxSpaceControlRequest, AgentMuxSpaceControlResult, AgentMuxSpatialSave } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { awaitDesktopPresentation, captureDesktopInput, desktopInputPreserved } from './desktop-presentation'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control'

export type WorkfaceRegionSwapPorts = {
  get(): SpatialWorkbench & { scratchTopicSnapshots: Readonly<Record<string, ScratchTopicsSnapshot>> }
  swapRegions(workspaceId: string, tabId: string, regionId: string, withRegionId: string): void
  closing(tabId: string): boolean
  save(layoutApplied: boolean): Promise<AgentMuxSpatialSave>
}

/** Swap positions in one original entity; display references do not create another layout owner. */
export async function executeWorkfaceRegionSwap(ports: WorkfaceRegionSwapPorts,
  request: Extract<AgentMuxSpaceControlRequest, { operation: 'space.swap' }>
): Promise<Extract<AgentMuxSpaceControlResult, { operation: 'space.swap' }>> {
  const state = ports.get()
  const owners = (id: string) => Object.entries(state.tabs).flatMap(([key, tab]) =>
    key === tab.id && Object.hasOwn(tab.regions, id) && tab.regions[id]?.regionId === id && regionIds(tab.layout.root).includes(id) ? [tab] : [])
  const source = owners(request.regionId), target = owners(request.withRegionId)
  const base = { operation: 'space.swap' as const, scope: 'tab-layout' as const, regionId: request.regionId,
    withRegionId: request.withRegionId, changed: false, save: null, locations: [] }
  const refused = (code: string, message: string) => ({ ...base, outcome: 'refused' as const, tabId: null, workspaceId: null,
    beforeOrder: [], afterOrder: [], activeRegionId: null, issues: [{ step: 'target', code, message,
      recovery: 'Inspect the exact original Regions and choose two members of the same Tab.' }] })
  if (source.length === 0 || target.length === 0) return refused('REGION_NOT_OPEN', 'An exact Region entity is not currently confirmed.')
  if (source.length !== 1 || target.length !== 1) return refused('AMBIGUOUS_REGION_TARGET', 'An exact Region entity has more than one original owner.')
  const tab = source[0]!
  if (tab !== target[0]) return refused('SPACE_PARENT_MISMATCH', 'Both Regions must belong to the same original Tab.')
  if (ports.closing(tab.id)) return refused('TAB_CLOSING', 'The original Tab is closing; its Regions are retained.')
  const topicsWorkspace = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const catalog = spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots, topicsWorkspace) ?? [])
  const locations = catalog.locations.filter(location => location.tabId === tab.id)
  const beforeOrder = regionIds(tab.layout.root)
  const owned = { ...base, tabId: tab.id, workspaceId: tab.workspaceId, beforeOrder, locations }
  if (request.regionId === request.withRegionId) return { ...owned, afterOrder: beforeOrder,
    activeRegionId: tab.layout.activeRegionId, outcome: 'unchanged', issues: [] }
  const input = captureDesktopInput(state.tabs)
  ports.swapRegions(tab.workspaceId, tab.id, request.regionId, request.withRegionId)
  const applied = ports.get().tabs
  const after = Object.hasOwn(applied, tab.id) ? applied[tab.id] : undefined
  if (!after) return { ...owned, afterOrder: [], activeRegionId: null, outcome: 'unknown', issues: [{ step: 'apply',
    code: 'SPACE_TARGET_UNKNOWN', message: 'The original Tab is no longer confirmed after the change.',
    recovery: 'Inspect current facts; do not replay a swap whose result is unknown.' }] }
  const afterOrder = regionIds(after.layout.root)
  const changed = beforeOrder.length !== afterOrder.length || beforeOrder.some((id, index) => id !== afterOrder[index])
  const save = changed ? await ports.save(true) : null
  const issues = save?.reason ? [{ step: 'save', code: 'SPACE_SAVE_UNCONFIRMED', message: save.reason,
    recovery: 'The applied layout is retained; inspect current facts before issuing another swap.' }] : []
  if (desktopInputPreserved(input, input)) await awaitDesktopPresentation(() => true)
  if (desktopInputPreserved(input, input) && !desktopInputPreserved(input, captureDesktopInput(ports.get().tabs))) issues.push({ step: 'input',
    code: 'INPUT_PRESERVATION_UNCONFIRMED', message: 'The previous input is no longer confirmed eligible in its original presentation.',
    recovery: 'The applied layout is retained; choose the current input explicitly.' })
  return { ...owned, afterOrder, activeRegionId: after.layout.activeRegionId, changed,
    outcome: issues.length ? 'partial' : changed ? 'swapped' : 'unchanged', save, issues }
}
