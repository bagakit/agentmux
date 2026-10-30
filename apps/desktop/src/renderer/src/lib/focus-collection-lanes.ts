import type { AgentMuxSpaceCatalog, TopicCategory } from '@agentmux/core/control'
import { homeZoneId, type SpaceZoneBindings } from '../../../shared/space-addresses'
import type { FocusContext } from './focus-context'
import type { FocusProjectLane } from './focus-project-lanes'

export type FocusTopicHeading = { id: string; name: string; summary: string | null }
export type FocusScanLane = FocusProjectLane & {
  /** Disposable scan projection; none of these IDs is a new Core Space/Session. */
  collection?: { categories: readonly TopicCategory[]; topics: readonly FocusProjectLane[]; confirmed: boolean; pending?: boolean }
}
export const focusTopicContextKey = (hostId: string, contextId: string) => JSON.stringify([hostId, contextId])

/** Join only original Topic home Zones. Display Tabs, Survey and title strings do not grant membership. */
export function deriveFocusCollectionLanes(lanes: readonly FocusProjectLane[], catalog: AgentMuxSpaceCatalog,
  content: { bindings: SpaceZoneBindings; categories: readonly TopicCategory[] }): FocusScanLane[] {
  const zones = new Map(catalog.zones.map(zone => [zone.zoneId, zone]))
  const spaces = new Map(catalog.spaces.map(space => [space.spaceId, space]))
  const categories = new Map(content.categories.map(category => [JSON.stringify([category.hostId, category.spaceId]), category]))
  const originalZones = new Map<string, string[]>()
  for (const [zoneId, binding] of Object.entries(content.bindings)) {
    const zone = zones.get(zoneId)
    if (!binding.topicId || binding.contentKind === 'mote' || !zone?.hostId || zone.workspaceId !== binding.workspaceId || zoneId !== homeZoneId(binding.spaceId)) continue
    const key = JSON.stringify([zone.hostId, binding.workspaceId, binding.topicId])
    const values = originalZones.get(key) ?? []; values.push(zoneId); originalZones.set(key, values)
  }
  const categoryBindings = new Map<string, string[]>()
  for (const binding of catalog.bindings) {
    // The catalog can offer a default display Category for an unclassified
    // legacy Topic. Only the original graph relation confirms membership.
    if (content.bindings[binding.zoneId]?.relations?.[binding.spaceId] !== true) continue
    if (spaces.get(binding.spaceId)?.kind !== 'container') continue
    const values = categoryBindings.get(binding.zoneId) ?? []; values.push(binding.spaceId); categoryBindings.set(binding.zoneId, values)
  }
  const result: FocusScanLane[] = []
  const collections = new Map<string, { lane: FocusScanLane; topics: FocusProjectLane[]; active: Set<string>; contexts: Set<string>; issues: Set<string> }>()
  for (const lane of lanes) {
    if (lane.objectKind !== 'topic' || !lane.topicId) { result.push(lane); continue }
    const source = originalZones.get(JSON.stringify([lane.hostId, lane.workspaceId, lane.topicId])) ?? []
    const ids = source.length === 1 ? [...new Set(categoryBindings.get(source[0]!) ?? [])].sort() : []
    const members = ids.flatMap(id => {
      const category = categories.get(JSON.stringify([lane.hostId, id]))
      return category && spaces.get(id)?.hostId === lane.hostId ? [category] : []
    })
    const confirmed = source.length === 1 && ids.length > 0 && members.length === ids.length
    const key = JSON.stringify(['focus-collection', lane.hostId, confirmed ? ids : 'unknown'])
    let entry = collections.get(key)
    if (!entry) {
      const name = confirmed ? members.length === 1 ? members[0]!.title : `Multiple Collections · ${members.map(member => member.title).join(' / ')}` : 'Collection not confirmed'
      const topics: FocusProjectLane[] = []
      const group: FocusScanLane = { id: key, workspaceId: '', projectId: '', projectWorkspaceId: null, name, labels: [name], path: '', hostId: lane.hostId,
        topicId: null, recovery: null, summary: null, activeAgentIds: [], contextIds: [], lastActivityAt: null,
        collection: { categories: members, topics, confirmed } }
      entry = { lane: group, topics, active: new Set(), contexts: new Set(), issues: new Set() }
      collections.set(key, entry); result.push(group)
    }
    for (const category of members) {
      for (const issue of [category.readError, spaces.get(category.spaceId)?.issue]) if (issue) entry.issues.add(`${category.title || category.spaceId}: ${issue}`)
    }
    entry.lane.summary = entry.issues.size ? [...entry.issues].join('\n') : null
    entry.topics.push(lane)
    for (const id of lane.activeAgentIds) if (!entry.active.has(id)) { entry.active.add(id); entry.lane.activeAgentIds.push(id) }
    for (const id of lane.contextIds) if (!entry.contexts.has(id)) { entry.contexts.add(id); entry.lane.contextIds.push(id) }
    if (lane.lastActivityAt != null) entry.lane.lastActivityAt = Math.max(entry.lane.lastActivityAt ?? 0, lane.lastActivityAt)
  }
  return result
}

export function focusCollectionTopicCount(lane: FocusScanLane): number {
  return new Set(lane.collection?.topics.map(topic => JSON.stringify([topic.hostId, topic.workspaceId, topic.topicId])) ?? []).size
}

/** Original Context references and Topic titles; no reader, navigation choice or duplicated Session. */
export function focusCollectionTopics(lane: FocusScanLane): ReadonlyMap<string, FocusTopicHeading> {
  const result = new Map<string, FocusTopicHeading>()
  for (const topic of lane.collection?.topics ?? []) {
    const heading = { id: JSON.stringify([topic.hostId, topic.workspaceId, topic.topicId]), name: topic.labels.at(-1) ?? topic.name, summary: topic.summary }
    for (const id of topic.contextIds) result.set(focusTopicContextKey(topic.hostId, id), heading)
  }
  return result
}

/** Explicit section presentation groups a state without modifying its state-entry facts. */
export function focusTopicSections(contexts: readonly FocusContext[], topics: ReadonlyMap<string, FocusTopicHeading>) {
  const grouped = new Map<string, FocusContext[]>()
  for (const context of contexts) {
    const key = topics.get(focusTopicContextKey(context.hostId, context.id))?.id ?? JSON.stringify(['context', context.hostId, context.id])
    const group = grouped.get(key) ?? []; group.push(context); grouped.set(key, group)
  }
  const sections = new Map<string, FocusTopicHeading>()
  for (const group of grouped.values()) {
    const first = group[0]!, key = focusTopicContextKey(first.hostId, first.id), topic = topics.get(key)
    if (topic) sections.set(key, topic)
  }
  return { contexts: [...grouped.values()].flat(), sections }
}
