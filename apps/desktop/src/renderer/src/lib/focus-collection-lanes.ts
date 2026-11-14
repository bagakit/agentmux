import type { ReactNode } from 'react'
import type { AgentMuxSpaceCatalog, TopicCategory } from '@agentmux/core/control'
import { homeZoneId, type SpaceZoneBindings } from '../../../shared/space-addresses'
import type { FocusContext } from './focus-context'
import { focusLaneOrderKey, focusLaneProjectKey, type FocusProjectLane } from './focus-project-lanes'
import { focusContextIdentityKey } from './focus-context-identity'
import { focusCollectionPreferenceKey } from '../../../shared/focus-project-preferences'

export type FocusTopicHeading = { id: string; name: string; summary: string | null; kind?: 'worktree'; content?: ReactNode; tagContent?: ReactNode; notice?: ReactNode }
export type FocusZoneHeadingView = { section: ReactNode; tag: ReactNode; notice?: ReactNode }
export type FocusScanLane = FocusProjectLane & {
  /** Disposable scan projection; none of these IDs is a new Core Space/Session. */
  /** Original worktree lanes, held by one stable project scan in either organization mode. */
  zones?: readonly FocusProjectLane[]
  zoneHeadings?: ReadonlyMap<string, FocusZoneHeadingView>
  zonePresentation?: import('../../../shared/focus-preferences').FocusTopicPresentation
  collection?: { categories: readonly TopicCategory[]; topics: readonly FocusProjectLane[]; confirmed: boolean; pending?: boolean }
}
export const focusTopicContextKey = focusContextIdentityKey

/** The same confirmed ordinary project owns its frame and any attached history. */
export function focusScanProjectKey(lane: FocusScanLane): string | undefined {
  return !lane.collection && !lane.topicId && !lane.locationUnconfirmed ? focusLaneProjectKey(lane) : undefined
}

/** Only confirmed original container identities can own a saved personal preference. */
export function focusScanPreferenceKey(lane: FocusScanLane): string | undefined {
  if (!lane.collection) return focusScanProjectKey(lane)
  const { confirmed, categories } = lane.collection
  return confirmed && categories.length > 0 && categories.every(category => category.hostId === lane.hostId)
    ? focusCollectionPreferenceKey(lane.hostId, categories.map(category => category.spaceId)) : undefined
}

export const focusScanOrderKey = (lane: FocusScanLane) => focusScanPreferenceKey(lane) ?? (lane.collection ? lane.id : focusLaneOrderKey(lane))

/** Disposable lookup built from the same immutable spatial facts as the catalog. */
export function createFocusCollectionIndex(catalog: AgentMuxSpaceCatalog,
  content: { bindings: SpaceZoneBindings; categories: readonly TopicCategory[] }) {
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
  return { spaces, categories, originalZones, categoryBindings }
}

/** Join only original Topic home Zones. Display Tabs, Survey and title strings do not grant membership. */
export function deriveFocusCollectionLanes(lanes: readonly FocusProjectLane[], catalog: AgentMuxSpaceCatalog,
  content: { bindings: SpaceZoneBindings; categories: readonly TopicCategory[] }): FocusScanLane[] {
  return projectFocusCollectionLanes(lanes, createFocusCollectionIndex(catalog, content))
}

export function projectFocusCollectionLanes(lanes: readonly FocusProjectLane[], index: ReturnType<typeof createFocusCollectionIndex>): FocusScanLane[] {
  const { spaces, categories, originalZones, categoryBindings } = index
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
        topicId: null, recovery: null, summary: null, activeAgentRefs: [], contextRefs: [], lastActivityAt: null,
        collection: { categories: members, topics, confirmed } }
      entry = { lane: group, topics, active: new Set(), contexts: new Set(), issues: new Set() }
      collections.set(key, entry); result.push(group)
    }
    for (const category of members) {
      for (const issue of [category.readError, spaces.get(category.spaceId)?.issue]) if (issue) entry.issues.add(`${category.title || category.spaceId}: ${issue}`)
    }
    entry.lane.summary = entry.issues.size ? [...entry.issues].join('\n') : null
    entry.topics.push(lane)
    for (const ref of lane.activeAgentRefs) { const key = focusTopicContextKey(ref.hostId, ref.id)
      if (!entry.active.has(key)) { entry.active.add(key); entry.lane.activeAgentRefs.push(ref) } }
    for (const ref of lane.contextRefs) { const key = focusTopicContextKey(ref.hostId, ref.id)
      if (!entry.contexts.has(key)) { entry.contexts.add(key); entry.lane.contextRefs.push(ref) } }
    if (lane.lastActivityAt != null) entry.lane.lastActivityAt = Math.max(entry.lane.lastActivityAt ?? 0, lane.lastActivityAt)
    if (lane.orderPriority !== undefined) entry.lane.orderPriority = Math.min(entry.lane.orderPriority ?? lane.orderPriority, lane.orderPriority)
  }
  return result
}

export function focusCollectionTopicCount(lane: FocusScanLane): number {
  return new Set(lane.collection?.topics.map(topic => JSON.stringify([topic.hostId, topic.workspaceId, topic.topicId])) ?? []).size
}

/** Filter the visible cohort without recomputing its original scope, rank or activity. */
export function filterFocusScanLanes(lanes: readonly FocusScanLane[], matches: (lane: FocusProjectLane) => boolean,
  references: ReadonlySet<string>): FocusScanLane[] {
  const trim = (lane: FocusProjectLane): FocusProjectLane[] => {
    if (!matches(lane)) return []
    const contextRefs = lane.contextRefs.filter(ref => references.has(focusTopicContextKey(ref.hostId, ref.id)))
    if (contextRefs.length === 0) return []
    return [{ ...lane, contextRefs, activeAgentRefs: lane.activeAgentRefs.filter(ref => references.has(focusTopicContextKey(ref.hostId, ref.id))) }]
  }
  return lanes.flatMap(lane => {
    if (!lane.collection) return trim(lane)
    const topics = lane.collection.topics.flatMap(trim)
    if (topics.length === 0) return []
    const shown = new Set(topics.flatMap(topic => topic.contextRefs.map(ref => focusTopicContextKey(ref.hostId, ref.id))))
    return [{ ...lane, collection: { ...lane.collection, topics },
      contextRefs: lane.contextRefs.filter(ref => shown.has(focusTopicContextKey(ref.hostId, ref.id))),
      activeAgentRefs: lane.activeAgentRefs.filter(ref => shown.has(focusTopicContextKey(ref.hostId, ref.id))) }]
  })
}

/** Original Context references and Topic titles; no reader, navigation choice or duplicated Session. */
export function focusCollectionTopics(lane: FocusScanLane): ReadonlyMap<string, FocusTopicHeading> {
  const result = new Map<string, FocusTopicHeading>()
  const memberships = new Map<string, FocusTopicHeading[]>()
  for (const topic of lane.zones ?? lane.collection?.topics ?? []) {
    if (lane.zones?.length === 1 && topic.labels.length === 1) continue
    const view = lane.zoneHeadings?.get(topic.id)
    const heading: FocusTopicHeading = { id: lane.zones ? topic.id : JSON.stringify([topic.hostId, topic.workspaceId, topic.topicId]),
      name: lane.zones ? topic.labels.slice(1).join(' / ') || 'Root' : topic.labels.at(-1) ?? topic.name,
      summary: topic.summary, ...(lane.zones ? { kind: 'worktree' as const, content: view?.section, tagContent: view?.tag, notice: view?.notice } : {}) }
    for (const ref of topic.contextRefs) {
      const key = focusTopicContextKey(ref.hostId, ref.id), held = memberships.get(key) ?? []
      if (!held.some(item => item.id === heading.id)) held.push(heading)
      memberships.set(key, held)
    }
  }
  for (const [key, held] of memberships) result.set(key, held.length === 1 ? held[0]! : {
    id: JSON.stringify(held.map(item => item.id)), name: held.map(item => item.name).join(' / '),
    summary: held.map(item => item.summary).filter(Boolean).join('\n') || null,
    ...(lane.zones ? { kind: 'worktree' as const, content: held.map(item => item.content), tagContent: held.map(item => item.tagContent),
      ...(held.some(item => item.notice !== undefined) ? { notice: held.map(item => item.notice) } : {}) } : {})
  })
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
