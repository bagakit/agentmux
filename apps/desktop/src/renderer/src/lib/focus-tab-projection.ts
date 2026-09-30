import { workbenchSurfaces, type WorkbenchTab } from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { AgentFocusContext } from './agent-focus'
import { sameWorkbenchProjectionSelection, type WorkbenchProjection, type WorkbenchProjectionSelection } from './workbench-projection'
import { selectSpatialCatalog } from './space-agent-control'

export type ExecutionFocusPresentation = {
  projection: WorkbenchProjection | null
  issue: string | null
  references: readonly WorkbenchProjectionSelection[]
}

/** Resolve an occurrence from authoritative membership, never from the first Session Tab. */
export function executionFocusPresentation(
  execution: AgentFocusContext['execution'],
  tabs: Readonly<Record<string, WorkbenchTab>>,
  catalog: AgentMuxSpaceCatalog | null,
  onSelect: WorkbenchProjection['onSelect']
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
  if (!reference || !choices.some(choice => sameWorkbenchProjectionSelection(choice, reference))) return {
    projection: null, references: choices,
    issue: execution.reference
      ? 'The selected Tab or Region occurrence is no longer confirmed. Its exact reference and Session are kept; choose an available location.'
      : choices.length > 1
        ? 'This Session has more than one work surface. Choose the exact location to open in Focus.'
        : 'No work surface occurrence is currently confirmed for this Session. Its identity is kept.'
  }
  return { projection: { entity: { kind: 'tab', tabId: reference.tabId }, presentationId: 'focus-workbench',
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
