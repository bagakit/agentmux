import type { AgentMuxSpaceCatalog } from '@agentmux/core'
import type { FocusProjectLane } from './focus-project-lanes'
import type { WorkbenchTab } from './workbench-tabs'
import type { SpaceZoneBindings } from '../../../shared/space-addresses'
import type { TopicCategory } from '@agentmux/core/control'

export type FocusLaneOrigin = {
  kind: 'project' | 'topic' | 'mote' | 'survey' | 'mixed' | 'unknown'
  label: string
  locations: readonly string[]
  addresses: readonly string[]
}

/** A disposable join of original spatial facts, never a content/identity registry.
 * Survey references are display membership and can coexist with Topic/Mote. */
export function focusLaneOrigins(lanes: readonly FocusProjectLane[], catalog: AgentMuxSpaceCatalog,
  tabs: Readonly<Record<string, WorkbenchTab>>, survey: readonly { zoneId: string; name: string }[], content: { bindings: SpaceZoneBindings; categories: readonly TopicCategory[] }): ReadonlyMap<string, FocusLaneOrigin> {
  const zonesBySession = new Map<string, Set<string>>()
  const tabZones = new Map(catalog.tabs.map(tab => [tab.tabId, tab.zoneId]))
  for (const tab of Object.values(tabs)) {
    const zone = tabZones.get(tab.id)
    if (!zone) continue
    for (const region of Object.values(tab.regions)) if ('sessionId' in region) {
      const zones = zonesBySession.get(region.sessionId) ?? new Set<string>()
      zones.add(zone); zonesBySession.set(region.sessionId, zones)
    }
  }
  const spaces = new Map(catalog.spaces.map(space => [space.spaceId, space]))
  const bound = new Map<string, typeof catalog.spaces>()
  const objectZones = new Map<string, Set<string>>()
  const categoryIds = new Set(content.categories.map(category => category.spaceId))
  const zoneFacts = new Map(catalog.zones.map(zone => [zone.zoneId, zone]))
  const contentZones = new Map<string, Set<string>>()
  for (const [zoneId, binding] of Object.entries(content.bindings)) {
    const zone = zoneFacts.get(zoneId)
    if (!binding.topicId || !zone?.hostId) continue
    const key = JSON.stringify([zone.hostId, binding.workspaceId, binding.topicId]), zones = contentZones.get(key) ?? new Set<string>()
    zones.add(zoneId); contentZones.set(key, zones)
  }
  for (const binding of catalog.bindings) {
    const space = spaces.get(binding.spaceId)
    if (space) {
      bound.set(binding.zoneId, [...(bound.get(binding.zoneId) ?? []), space])
      if ((space.kind === 'topic' || space.kind === 'mote') && space.topicId) {
        const key = JSON.stringify([space.hostId, space.topicId]), zones = objectZones.get(key) ?? new Set<string>()
        zones.add(binding.zoneId); objectZones.set(key, zones)
      }
    }
  }
  const explorations = new Map(survey.map(item => [item.zoneId, item.name]))
  return new Map(lanes.map(lane => {
    const zones = new Set(lane.contextIds.flatMap(id => [...(zonesBySession.get(id) ?? [])]))
    // Topic content identity remains usable when its Session has no open view.
    if (lane.topicId) for (const zone of objectZones.get(JSON.stringify([lane.hostId, lane.topicId])) ?? []) zones.add(zone)
    if (lane.topicId) for (const zone of contentZones.get(JSON.stringify([lane.hostId, lane.workspaceId, lane.topicId])) ?? []) zones.add(zone)
    const locations = new Map<string, string>()
    for (const zone of zones) for (const space of bound.get(zone) ?? []) {
      if (space.hostId === lane.hostId && (categoryIds.has(space.spaceId) || (lane.objectKind === 'mote' && space.kind === 'folder'))) locations.set(space.spaceId, space.name)
    }
    const surveyed = [...zones].filter(zone => explorations.has(zone))
    for (const zone of surveyed) locations.set(zone, lane.objectKind ? `Survey · ${explorations.get(zone)!}` : explorations.get(zone)!)
    const allSurvey = lane.contextIds.length > 0 && lane.contextIds.every(id => {
      const memberZones = zonesBySession.get(id)
      return memberZones !== undefined && memberZones.size > 0 && [...memberZones].every(zone => explorations.has(zone))
    })
    const kind = lane.objectKind === 'topic' || lane.objectKind === 'mote' ? lane.objectKind
      : lane.topicId ? 'unknown' : allSurvey ? 'survey' : surveyed.length ? 'mixed' : 'project'
    const label = kind === 'topic' ? 'Topic' : kind === 'mote' ? 'Mote' : kind === 'survey' ? 'Survey' : kind === 'mixed' ? 'Project · Survey' : kind === 'unknown' ? 'Source unknown' : 'Project'
    return [lane.id, { kind, label, locations: locations.size ? [...locations.values()] : kind === 'topic' ? ['Location unknown'] : [],
      addresses: [...locations].map(([id, name]) => `${name} · ${id}`) }]
  }))
}
