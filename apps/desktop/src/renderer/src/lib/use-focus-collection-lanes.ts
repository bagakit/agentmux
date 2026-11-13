import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, type RefObject } from 'react'
import type { AgentMuxSpaceCatalog, TopicCategory } from '@agentmux/core/control'
import type { SpaceZoneBindings } from '../../../shared/space-addresses'
import type { FocusProjectLane } from './focus-project-lanes'
import { createFocusCollectionIndex, focusTopicContextKey, projectFocusCollectionLanes, type FocusScanLane } from './focus-collection-lanes'

function interacting(rows: RefObject<HTMLElement | null>, pressed: RefObject<boolean>) {
  const root = rows.current
  if (!root) return false
  if (pressed.current || root.querySelector('.is-menu-open, .focus-context--renaming') || root.contains(root.ownerDocument.activeElement)) return true
  const selection = root.ownerDocument.defaultView?.getSelection()
  return Boolean(selection && !selection.isCollapsed && selection.anchorNode && root.contains(selection.anchorNode))
}
const membership = (lanes: readonly FocusScanLane[]) => JSON.stringify(lanes.map(lane => [lane.id, lane.contextIds]))
type CollectionIndex = ReturnType<typeof createFocusCollectionIndex>

/** Keep existing Contexts in their committed presentation while new ones use current facts. */
function heldProjection(lanes: readonly FocusProjectLane[], previous: readonly FocusProjectLane[],
  priorIndex: CollectionIndex | null, currentIndex: CollectionIndex | null): FocusScanLane[] {
  const originals = new Map(previous.flatMap(lane => lane.contextIds.map(id => [focusTopicContextKey(lane.hostId, id), lane] as const)))
  const segments = new Map<string, { lane: FocusProjectLane; index: CollectionIndex | null }>()
  for (const lane of lanes) {
    const active = new Set(lane.activeAgentIds)
    for (const id of lane.contextIds) {
      const original = originals.get(focusTopicContextKey(lane.hostId, id))
      let source = original ?? lane
      if (original && original.id === lane.id) {
        // Hold only the previous classification; current labels and status stay live.
        const { objectKind: _currentKind, ...current } = lane
        source = original.objectKind ? { ...current, objectKind: original.objectKind } : current
      }
      const key = JSON.stringify([Boolean(original), source.hostId, source.id])
      let segment = segments.get(key)
      if (!segment) {
        segment = { lane: { ...source, contextIds: [], activeAgentIds: [], lastActivityAt: null }, index: original ? priorIndex : currentIndex }
        segments.set(key, segment)
      }
      segment.lane.contextIds.push(id)
      if (active.has(id)) segment.lane.activeAgentIds.push(id)
      segment.lane.lastActivityAt = Math.max(segment.lane.lastActivityAt ?? 0, lane.lastActivityAt ?? 0) || null
    }
  }
  const result = new Map<string, { lane: FocusScanLane; topics: FocusProjectLane[]; issues: Set<string> }>()
  for (const { lane, index } of segments.values()) {
    for (const projected of index ? projectFocusCollectionLanes([lane], index) : [lane as FocusScanLane]) {
      let entry = result.get(projected.id)
      if (!entry) {
        entry = { lane: projected, topics: [], issues: new Set() }
        result.set(projected.id, entry)
      } else {
        entry.lane.contextIds.push(...projected.contextIds)
        entry.lane.activeAgentIds.push(...projected.activeAgentIds)
        entry.lane.lastActivityAt = Math.max(entry.lane.lastActivityAt ?? 0, projected.lastActivityAt ?? 0) || null
      }
      if (projected.collection) entry.topics.push(...projected.collection.topics)
      if (projected.summary) entry.issues.add(projected.summary)
    }
  }
  return [...result.values()].map(({ lane, topics, issues }) => ({ ...lane,
    summary: [...issues].join('\n') || null, ...(lane.collection ? { collection: { ...lane.collection, topics } } : {}) }))
}

/** Defer only reparenting while a card is being used. Current Context facts,
 * new Agents and original control/navigation stay with their original owners. */
export function useFocusCollectionLanes(lanes: readonly FocusProjectLane[], catalog: AgentMuxSpaceCatalog,
  content: { bindings: SpaceZoneBindings; categories: readonly TopicCategory[] }, rows: RefObject<HTMLElement | null>, pressed: RefObject<boolean>, visible: boolean): FocusScanLane[] {
  const hasTopics = lanes.some(lane => lane.objectKind === 'topic' && lane.topicId)
  const index = useMemo(() => visible && hasTopics ? createFocusCollectionIndex(catalog, content) : null, [visible, hasTopics, catalog, content])
  const lastIndex = useRef(index)
  // While hidden, keep projecting current lanes through the last known index;
  // on reveal the latest catalog is rebuilt before it can affect membership.
  const currentIndex = index ?? lastIndex.current
  const held = useRef({ index: currentIndex, lanes })
  const [, update] = useReducer(value => value + 1, 0)
  const desired: FocusScanLane[] = currentIndex ? projectFocusCollectionLanes(lanes, currentIndex) : [...lanes]
  const prior = held.current
  const originalByContext = new Map(prior.lanes.flatMap(lane => lane.contextIds.map(id => [focusTopicContextKey(lane.hostId, id), lane] as const)))
  const sourcesChanged = prior.index !== currentIndex || lanes.some(lane => lane.contextIds.some(id => {
    const original = originalByContext.get(focusTopicContextKey(lane.hostId, id))
    return original && (original.id !== lane.id || original.objectKind !== lane.objectKind)
  }))
  const heldSources = sourcesChanged ? heldProjection(lanes, prior.lanes, prior.index, currentIndex) : desired
  const pending = membership(desired) !== membership(heldSources) && interacting(rows, pressed)
  useLayoutEffect(() => {
    if (index) lastIndex.current = index
    else if (visible && !hasTopics && !pending) lastIndex.current = null
    if (!pending) held.current = { index: visible && !hasTopics ? null : currentIndex, lanes }
  }, [index, visible, hasTopics, pending, currentIndex, lanes])
  useEffect(() => {
    if (!pending || !rows.current) return
    const root = rows.current, document = root.ownerDocument
    const flush = () => { if (!interacting(rows, pressed)) update() }
    // One-shot interaction release, not a polling timer or a fact subscription.
    const observer = new MutationObserver(flush)
    observer.observe(root, { childList: true, subtree: true })
    document.addEventListener('focusout', flush)
    document.addEventListener('pointerup', flush)
    document.addEventListener('keyup', flush)
    return () => { observer.disconnect(); document.removeEventListener('focusout', flush); document.removeEventListener('pointerup', flush); document.removeEventListener('keyup', flush) }
  }, [pending, rows, pressed])
  if (!pending) return desired
  const desiredIds = new Map(desired.flatMap(lane => (lane.collection?.topics ?? [lane]).flatMap(topic =>
    topic.contextIds.map(id => [focusTopicContextKey(topic.hostId, id), lane.id] as const))))
  return heldSources.map(lane => lane.collection ? { ...lane, collection: { ...lane.collection,
    pending: lane.collection.topics.some(topic => topic.contextIds.some(id => desiredIds.get(focusTopicContextKey(topic.hostId, id)) !== lane.id)) } } : lane)
}
