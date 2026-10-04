import { workbenchSurfaces, type WorkbenchTab } from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'
import type { AgentMuxDesktopSpaceSelection, AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { AgentFocusContext } from './agent-focus'
import { sameWorkbenchProjectionSelection, type WorkbenchProjection, type WorkbenchProjectionSelection } from './workbench-projection'
import { mainRegionReference } from './desktop-focus-navigation'
import { selectSpatialCatalog } from './space-agent-control'

export type ExecutionFocusPresentation = {
  projection: WorkbenchProjection | null
  issue: string | null
  references: readonly WorkbenchProjectionSelection[]
  unselected?: boolean
}

/** Main presentation consumes the durable Desktop choice, independently of Agent MRU. */
export function mainFocusPresentation(
  choice: AgentMuxDesktopSpaceSelection | null,
  tabs: Readonly<Record<string, WorkbenchTab>>,
  catalog: AgentMuxSpaceCatalog | null,
  onSelect: WorkbenchProjection['onSelect'],
  level: 'tab' | 'region' = 'tab'
): ExecutionFocusPresentation {
  if (!choice) return { projection: null, issue: null, references: [] }
  // A parent with no selected leaf is a normal navigation choice, not an
  // unconfirmed Region. Keep all original members without selecting a peer.
  if (catalog && !choice.tabId && !choice.regionId && choice.zoneId &&
    catalog.zones.some(zone => zone.zoneId === choice.zoneId && zone.kind !== 'unknown' && !zone.issue) &&
    (choice.spaceId === null
      ? !catalog.bindings.some(binding => binding.zoneId === choice.zoneId)
      : catalog.bindings.some(binding => binding.zoneId === choice.zoneId && binding.spaceId === choice.spaceId))) {
    return { projection: { entity: { kind: 'zone', zoneId: choice.zoneId },
      presentationId: 'focus-workbench', displayWorkspaceId: choice.workspaceId,
      catalog, selectionMode: 'occurrence', selection: [], onSelect }, issue: null, references: [] }
  }
  if (catalog && !choice.tabId && !choice.zoneId &&
    catalog.spaces.some(space => space.spaceId === choice.spaceId && !space.issue)) {
    return { projection: null, issue: null, references: [], unselected: true }
  }
  const references = catalog?.locations.filter(location => location.displayWorkspaceId === choice.workspaceId &&
    location.spaceId === choice.spaceId && location.zoneId === choice.zoneId &&
    location.tabId === choice.tabId && (!choice.regionId || location.regionId === choice.regionId)).map(location => ({
      displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId })) ?? []
  const reference = mainRegionReference(choice)
  if (!catalog || !reference || !tabs[reference.tabId]?.regions[reference.regionId] ||
    !references.some(location => sameWorkbenchProjectionSelection(location, reference))) return { projection: null, references,
    issue: 'The selected object has no confirmed Region occurrence. Its original workface and reference are kept; choose an exact existing location.' }
  return { projection: { entity: level === 'region' ? { kind: 'region', regionId: reference.regionId } : { kind: 'tab', tabId: reference.tabId },
    presentationId: 'focus-workbench', displayWorkspaceId: reference.displayWorkspaceId,
    catalog: selectSpatialCatalog(catalog, { displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId }),
    selection: [reference], onSelect }, issue: null, references }
}

/** Resolve an occurrence from authoritative membership, never from the first Session Tab. */
export function executionFocusPresentation(
  execution: AgentFocusContext['execution'],
  tabs: Readonly<Record<string, WorkbenchTab>>,
  catalog: AgentMuxSpaceCatalog | null,
  onSelect: WorkbenchProjection['onSelect'],
  level: 'tab' | 'region' = 'tab'
): ExecutionFocusPresentation {
  if (!execution.sessionId) return { projection: null, issue: null, references: [] }
  if (!catalog) return { projection: null, issue: 'The original work surface directory is still restoring. Its Session and exact reference are kept.', references: [] }
  const semanticRegions = new Set(catalog.regions.filter(region => region.agentSessionId === execution.sessionId).map(region => region.regionId))
  const references = new Map<string, WorkbenchProjectionSelection>()
  for (const location of catalog.locations) {
    const surface = tabs[location.tabId]?.regions[location.regionId]
    if (!semanticRegions.has(location.regionId) || !surface || !isSessionSurface(surface) || surface.sessionId !== execution.sessionId) continue
    const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId,
      tabId: location.tabId, regionId: location.regionId }
    references.set(JSON.stringify(reference), reference)
  }
  const choices = [...references.values()]
  const reference = execution.reference ?? (choices.length === 1 ? choices[0] : undefined)
  const confirmed = reference && choices.some(choice => sameWorkbenchProjectionSelection(choice, reference))
  if (!confirmed) return {
    projection: null, references: choices,
    issue: execution.reference
      ? 'The selected Tab or Region occurrence is no longer confirmed. Its exact reference and Session are kept; choose an available location.'
      : choices.length > 1
        ? 'This Session has more than one work surface. Choose the exact location to open in Focus.'
        : 'No work surface occurrence is currently confirmed for this Session. Its identity is kept.'
  }
  return { projection: { entity: level === 'region' ? { kind: 'region', regionId: reference.regionId } : { kind: 'tab', tabId: reference.tabId }, presentationId: 'focus-workbench',
    displayWorkspaceId: reference.displayWorkspaceId,
    catalog: selectSpatialCatalog(catalog, { displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId }),
    selection: [reference], onSelect },
    issue: null, references: choices }
}

/** Resolve the durable Tab that owns a focused execution session. */
export function tabForFocusedSession(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  sessionId: string | null
): WorkbenchTab | null {
  if (!sessionId) return null
  // isSessionSurface is the SSOT for "agent-or-terminal": routing through it means a sixth
  // session-bearing surface kind added to WorkbenchSurface would break this call site at compile
  // time (via the exhaustiveness backstop in workbench-surface-kinds.ts), not silently drop the
  // new kind from focus routing — the failure mode workbench-surface-kind-exhaustiveness.test.ts
  // is guarding against.
  return Object.values(tabs).find((tab) => workbenchSurfaces(tab).some((surface) => (
    isSessionSurface(surface) && surface.sessionId === sessionId
  ))) ?? null
}
