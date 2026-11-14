import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { desktopWorkbenchFromSpatial } from './desktop-spatial-state'
import { findWorkbenchRegion } from './workbench-tabs'
import { hydratePersistedTab } from './workbench-persistence'
import { sameWorkbenchSurfaceOwnerReference, workbenchSurfaceOwner, type WorkbenchViewCloseSurfaceOwner } from './workbench-view-close'
import type { SurveyCompositionReport, SurveyCompositionRequest } from './survey-tab-composition'

/** An unresolved user operation, saved by the original Workbench preference owner. Never replayable. */
export type SurveyCompositionRecovery = {
  requestId: string
  target: SurveyCompositionRequest['target']
  sources: ({ tabId: string; zoneId: string | null; owners: WorkbenchViewCloseSurfaceOwner[] } &
    ({ kind: 'tab' } | { kind: 'page'; promotedTabId: string }))[]
  report: SurveyCompositionReport
}
export type SurveyCompositionReview = { targetConfirmed: boolean; referencesRepaired: boolean; issue: string }

export function retainSurveyComposition(request: SurveyCompositionRequest, report: SurveyCompositionReport): SurveyCompositionRecovery {
  return { requestId: request.requestId, target: request.target, report, sources: request.sources.map(source => ({
    tabId: source.tab.id, zoneId: source.zoneId,
    ...(source.kind === 'page' ? { kind: 'page' as const, promotedTabId: source.promotedTabId } : { kind: 'tab' as const }),
    owners: Object.values(source.tab.regions).filter(region => source.kind === 'tab' || region.regionId === source.regionId).map(workbenchSurfaceOwner)
  })) }
}

/** Current target facts only. A later read never turns a lost acknowledgement into a confirmed receipt. */
export function surveyCompositionTargetConfirmed(recovery: SurveyCompositionRecovery, graph: AgentMuxSpatialGraph): boolean {
  const zone = graph.zones.find(zone => zone.zoneId === recovery.target.zoneId)
  if (!zone || zone.workspaceId !== recovery.target.workspaceId || !recovery.sources.length) return false
  const tabs = Object.fromEntries(Object.entries(desktopWorkbenchFromSpatial(graph).tabs).map(([id, tab]) => [id, hydratePersistedTab(tab)]))
  return recovery.sources.every(source => source.owners.length > 0 && source.owners.every(owner => {
    const current = findWorkbenchRegion(tabs, owner.regionId)
    const tab = current && graph.tabs.find(tab => tab.tabId === current.tab.id)
    // A page may have been the entire original Tab or separated after a later split.
    // Both identities were reserved by this exact intent; a later read confirms neither old ACK.
    return Boolean(current && (current.tab.id === source.tabId || source.kind === 'page' && current.tab.id === source.promotedTabId) && tab?.zoneId === recovery.target.zoneId &&
      sameWorkbenchSurfaceOwnerReference(current.surface, owner))
  }))
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
function owner(value: unknown): boolean {
  if (!record(value) || !text(value.regionId)) return false
  switch (value.kind) {
    case 'browser': return text(value.browserId)
    case 'file': return text(value.workspaceId) && text(value.path)
    case 'agent': case 'terminal': return (value.phase === 'attached' || value.phase === 'launching') && text(value.sessionId) && (value.runId === null || text(value.runId))
    case 'git': case 'git-diff': return text(value.identity)
    case 'launcher': return true
    default: return false
  }
}
export function isSurveyCompositionRecovery(value: unknown): value is SurveyCompositionRecovery {
  if (!record(value) || !text(value.requestId) || !record(value.target) || !record(value.report) || !Array.isArray(value.sources) || !value.sources.length) return false
  const target = value.target, report = value.report
  return (target.kind === 'existing' || target.kind === 'new-research') && ['zoneId', 'workspaceId', 'displayWorkspaceId', 'groupId'].every(key => text(target[key])) &&
    report.requestId === value.requestId && report.targetZoneId === target.zoneId && ['unknown', 'partial'].includes(report.outcome as string) &&
    Array.isArray(report.tabIds) && report.tabIds.every(text) && value.sources.every(source => record(source) &&
      (source.kind === 'tab' || source.kind === 'page' && text(source.promotedTabId)) && text(source.tabId) && (source.zoneId === null || text(source.zoneId)) &&
      Array.isArray(source.owners) && source.owners.length > 0 && source.owners.every(owner))
}
/** Unknown records remain in the same preference field and receive a visible service window. */
export function restoreSurveyCompositionRecoveries(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}
export function changeSurveyCompositionRecovery(values: readonly unknown[], requestId: string, value?: SurveyCompositionRecovery): unknown[] {
  return [...values.filter(entry => !isSurveyCompositionRecovery(entry) || entry.requestId !== requestId), ...(value ? [value] : [])]
}
