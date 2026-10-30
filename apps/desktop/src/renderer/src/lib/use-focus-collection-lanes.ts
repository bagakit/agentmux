import { useEffect, useReducer, useRef, type RefObject } from 'react'
import type { AgentMuxSpaceCatalog, TopicCategory } from '@agentmux/core/control'
import type { SpaceZoneBindings } from '../../../shared/space-addresses'
import type { FocusProjectLane } from './focus-project-lanes'
import { deriveFocusCollectionLanes, type FocusScanLane } from './focus-collection-lanes'

function interacting(rows: RefObject<HTMLElement | null>, pressed: RefObject<boolean>) {
  const root = rows.current
  if (!root) return false
  if (pressed.current || root.querySelector('.is-menu-open, .focus-context--renaming') || root.contains(root.ownerDocument.activeElement)) return true
  const selection = root.ownerDocument.defaultView?.getSelection()
  return Boolean(selection && !selection.isCollapsed && selection.anchorNode && root.contains(selection.anchorNode))
}
const membership = (lanes: readonly FocusScanLane[]) => JSON.stringify(lanes.map(lane => [lane.id, lane.contextIds]))

/** Defer only reparenting while a card is being used. Current Context facts,
 * new Agents and original control/navigation stay with their original owners. */
export function useFocusCollectionLanes(lanes: readonly FocusProjectLane[], catalog: AgentMuxSpaceCatalog,
  content: { bindings: SpaceZoneBindings; categories: readonly TopicCategory[] }, rows: RefObject<HTMLElement | null>, pressed: RefObject<boolean>): FocusScanLane[] {
  const held = useRef({ catalog, content, kinds: new Map(lanes.map(lane => [lane.id, lane.objectKind])) })
  const [, update] = useReducer(value => value + 1, 0)
  const desired = deriveFocusCollectionLanes(lanes, catalog, content)
  const prior = held.current
  const heldSources = prior.catalog === catalog && prior.content === content ? desired : deriveFocusCollectionLanes(
    lanes.map(lane => {
      if (!prior.kinds.has(lane.id)) return lane
      const kind = prior.kinds.get(lane.id), { objectKind: _kind, ...base } = lane
      return kind ? { ...base, objectKind: kind } : base
    }), prior.catalog, prior.content)
  const pending = membership(desired) !== membership(heldSources) && interacting(rows, pressed)
  if (!pending) held.current = { catalog, content, kinds: new Map(lanes.map(lane => [lane.id, lane.objectKind])) }
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
  const desiredIds = new Map(desired.flatMap(lane => (lane.collection?.topics ?? [lane]).map(topic => [topic.id, lane.id] as const)))
  return heldSources.map(lane => lane.collection ? { ...lane, collection: { ...lane.collection,
    pending: lane.collection.topics.some(topic => desiredIds.get(topic.id) !== lane.id) } } : lane)
}
