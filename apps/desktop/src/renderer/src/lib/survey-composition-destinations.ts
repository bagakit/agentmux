import type { AgentMuxSpaceCatalog, AgentMuxSurveyPageReference } from '@agentmux/core/control'
import { groupIds } from '@agentmux/layout'
import type { AppState } from '../store'
import type { SurveyCompositionSource, SurveyCompositionTarget } from './survey-tab-composition'
import { surveyExplorationName } from './survey-exploration-name'
import { surveyPageOwner } from './survey-page-references'

export type SurveyCompositionDestinationIntent = { kind: 'existing'; zoneId?: string } |
  { kind: 'new-research'; zoneId: string; anchor?: AgentMuxSurveyPageReference }
export type SurveyCompositionDestination = { value: string; label: string; description: string; target: SurveyCompositionTarget }
/** Only existing machine-confirmed positions become choices; the UI never supplies a guessed first location. */
export function surveyCompositionDestinations(state: Pick<AppState, 'config' | 'tabs' | 'layouts' | 'surveyCollectedZones' | 'surveyExplorationNames'>,
  catalog: AgentMuxSpaceCatalog | null, sources: readonly SurveyCompositionSource[], intent: SurveyCompositionDestinationIntent = { kind: 'existing' }): SurveyCompositionDestination[] {
  if (!catalog) return []
  const result: SurveyCompositionDestination[] = [], seen = new Set<string>()
  const add = (target: SurveyCompositionTarget, label: string) => {
    const layout = state.layouts[target.displayWorkspaceId], resource = state.config?.workspaces.find(workspace => workspace.id === target.workspaceId)
    if (!layout || !resource || !groupIds(layout.root).includes(target.groupId)) return
    const value = JSON.stringify(target.kind === 'new-research' ? [target.zoneId, target.workspaceId, target.displayWorkspaceId, target.groupId] : [target.zoneId, target.displayWorkspaceId, target.groupId])
    if (seen.has(value)) return
    seen.add(value)
    result.push({ value, label, target, description: `${target.kind === 'new-research' ? resource.path + ' · ' : ''}${state.config?.workspaces.find(workspace => workspace.id === target.displayWorkspaceId)?.name ?? 'Original workspace'} · Group ${groupIds(layout.root).indexOf(target.groupId) + 1}` })
  }
  if (intent.kind === 'new-research') {
    const anchor = intent.anchor ? surveyPageOwner(state.tabs, intent.anchor, catalog) : null
    const references = intent.anchor ? anchor ? [{ tab: anchor.tab, regionId: intent.anchor.regionId, workspaceId: anchor.surface.workspaceId }] : []
      : sources.flatMap(source => source.kind === 'page' ? [{ tab: source.tab, regionId: source.regionId, workspaceId: source.tab.regions[source.regionId]!.workspaceId }]
        : [{ tab: source.tab, regionId: source.tab.layout.activeRegionId, workspaceId: source.tab.workspaceId }])
    for (const reference of references) for (const position of catalog.locations) {
      if (position.tabId !== reference.tab.id || position.regionId !== reference.regionId) continue
      add({ kind: 'new-research', zoneId: intent.zoneId, workspaceId: reference.workspaceId, displayWorkspaceId: position.displayWorkspaceId, groupId: position.groupId },
        state.config?.workspaces.find(workspace => workspace.id === reference.workspaceId)?.name ?? 'Original resource')
    }
    return result
  }
  for (const zone of catalog.zones) {
    if (!state.surveyCollectedZones[zone.zoneId] || intent.zoneId && intent.zoneId !== zone.zoneId || sources.every(source => source.zoneId === zone.zoneId)) continue
    const positions = catalog.locations.filter(location => location.zoneId === zone.zoneId)
    const choices = positions.length ? positions.map(location => ({ displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId }))
      : (state.layouts[zone.workspaceId]?.groups ?? []).map(group => ({ displayWorkspaceId: zone.workspaceId, groupId: group.id }))
    const members = catalog.tabs.filter(tab => tab.zoneId === zone.zoneId).flatMap(tab => state.tabs[tab.tabId] ? [state.tabs[tab.tabId]!] : [])
    for (const position of choices) add({ kind: 'existing', zoneId: zone.zoneId, workspaceId: zone.workspaceId, ...position },
      surveyExplorationName(state.surveyExplorationNames[zone.zoneId], members))
  }
  return result
}
