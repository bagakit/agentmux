import { CollaborationBoundsIndex, collaborationBoundsOverlap as overlap } from './collaboration-spatial-index'
import type { CollaborationLayoutBox, CollaborationLayoutInput, CollaborationLayoutPoint, CollaborationLayoutStructure, CollaborationLayoutWork } from './collaboration-layout-engine'

export const COLLABORATION_LOCAL_LAYOUT_PASSES = 4
export const COLLABORATION_LOCAL_LAYOUT_CANDIDATES = 48
const center = (box: CollaborationLayoutBox) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
const squared = (a: CollaborationLayoutPoint, b: CollaborationLayoutPoint) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
type Spring = { source: string; target: string; weight: number }

/** One finite, deterministic descent over the changed neighborhood, with the rest of the world fixed. */
export function refineCollaborationNeighborhood(input: CollaborationLayoutInput, previousStructure: CollaborationLayoutStructure,
  held: ReadonlyMap<string, CollaborationLayoutBox>, placed: Map<string, CollaborationLayoutBox>, regions: readonly CollaborationLayoutBox[],
  anchor: string | null, springs: readonly Spring[], work: CollaborationLayoutWork, gap: number, signal?: AbortSignal): void {
  const oldNodes = new Map(previousStructure.nodes.map(node => [node.id, node])), nodes = new Map(input.nodes.map(node => [node.id, node]))
  const oldAreas = new Map(previousStructure.areas.map(area => [area.id, area])), areas = new Map(input.areas.map(area => [area.id, area]))
  const changed = new Set<string>(), changedAreas = new Set<string>(), reclaim = new Set<string>(), focus = new Map<string, CollaborationLayoutPoint[]>()
  const seed = (id: string, areaId: string, box: CollaborationLayoutBox | undefined) => {
    changed.add(id); changedAreas.add(areaId)
    if (box) { const values = focus.get(areaId) ?? []; values.push(center(box)); focus.set(areaId, values) }
  }
  for (const id of [...new Set([...oldNodes.keys(), ...nodes.keys()])].sort()) {
    const old = oldNodes.get(id), node = nodes.get(id)
    if (old?.areaId === node?.areaId && old?.width === node?.width && old?.height === node?.height) continue
    if (old) seed(id, old.areaId, held.get(id))
    if (node) seed(id, node.areaId, placed.get(id))
    if (old && (!node || old.areaId !== node.areaId || old.width > node.width || old.height > node.height)) reclaim.add(old.areaId)
  }
  for (const node of input.nodes) {
    const old = held.get(node.id), current = placed.get(node.id)
    if (!changed.has(node.id) && old?.kind === 'agent' && current?.kind === 'agent' && squared(center(old), center(current)) > .01)
      seed(node.id, node.areaId, current)
  }
  const inSubtree = (areaId: string, root: string, tree: typeof areas) => {
    let id: string | null | undefined = areaId
    while (id) { if (id === root) return true; id = tree.get(id)?.parentId }
    return false
  }
  for (const id of [...new Set([...oldAreas.keys(), ...areas.keys()])].sort()) {
    const old = oldAreas.get(id), area = areas.get(id)
    if (old && area && (old.parentId ?? null) === (area.parentId ?? null) && old.folded === area.folded) continue
    changedAreas.add(id)
    // A fold or true reparent changes a subtree's footprint; its identities stay intact.
    for (const node of [...previousStructure.nodes].sort((a, b) => a.id.localeCompare(b.id))) if (inSubtree(node.areaId, id, oldAreas)) seed(node.id, node.areaId, held.get(node.id))
    for (const node of [...input.nodes].sort((a, b) => a.id.localeCompare(b.id))) if (inSubtree(node.areaId, id, areas)) seed(node.id, node.areaId, placed.get(node.id))
    if (old?.parentId) { changedAreas.add(old.parentId); const values = focus.get(old.parentId) ?? []; const box = held.get(id); if (box) values.push(center(box)); focus.set(old.parentId, values) }
    if (area?.parentId) { changedAreas.add(area.parentId); const values = focus.get(area.parentId) ?? []; const box = placed.get(id); if (box) values.push(center(box)); focus.set(area.parentId, values) }
  }
  const incident = new Map<string, Spring[]>()
  for (const spring of springs) for (const id of [spring.source, spring.target]) {
    const values = incident.get(id) ?? []; values.push(spring); incident.set(id, values)
  }
  const movable = new Set([...changed].filter(id => placed.get(id)?.kind === 'agent'))
  for (const id of changed) for (const spring of incident.get(id) ?? []) {
    const peer = spring.source === id ? spring.target : spring.source
    if (placed.get(peer)?.kind === 'agent') { movable.add(peer); changedAreas.add(nodes.get(peer)!.areaId) }
  }
  // Nearby survivors can reclaim a deleted/shrunken member's old space even without an edge.
  for (const [areaId, points] of focus) {
    const members = areas.get(areaId)?.members ?? []
    for (const point of points) for (const id of members.filter(id => !changed.has(id) && placed.get(id)?.kind === 'agent')
      .sort((a, b) => squared(center(placed.get(a)!), point) - squared(center(placed.get(b)!), point) || a.localeCompare(b)).slice(0, 2)) movable.add(id)
  }
  movable.delete(anchor ?? '')
  const order = [...movable].sort(), fixed = new CollaborationBoundsIndex([...placed.values()].filter(box => !movable.has(box.id)))
  const regionIndex = new CollaborationBoundsIndex(regions.filter(box => box.kind === 'area'))
  const ancestors = new Map<string, Set<string>>()
  for (const areaId of new Set(order.map(id => nodes.get(id)!.areaId))) {
    const values = new Set<string>(); let id: string | null | undefined = areaId
    while (id) { values.add(id); id = areas.get(id)?.parentId }
    ancestors.set(areaId, values)
  }
  const origins = new Map<string, CollaborationLayoutPoint>()
  for (const [areaId, points] of focus) if (points.length) origins.set(areaId, {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length })
  work.areas = changedAreas.size; work.nodes = order.length
  for (let pass = 0; pass < COLLABORATION_LOCAL_LAYOUT_PASSES && order.length; pass++) {
    work.passes++; let improved = false
    for (const id of order) {
      signal?.throwIfAborted()
      const box = placed.get(id)!, current = center(box), previous = held.get(id), node = nodes.get(id)!
      const original = previous?.kind === 'agent' && previous.areaId === node.areaId ? center(previous) : current
      const origin = origins.get(node.areaId) ?? current, edges = incident.get(id) ?? [], displacement = previous?.areaId === node.areaId ? 4 : .25
      const compactness = reclaim.has(node.areaId) ? 4 : .35
      let total = displacement + compactness, x = displacement * original.x + compactness * origin.x, y = displacement * original.y + compactness * origin.y
      for (const spring of edges) {
        const peer = placed.get(spring.source === id ? spring.target : spring.source)
        if (!peer) continue
        const point = center(peer); total += spring.weight; x += point.x * spring.weight; y += point.y * spring.weight
      }
      const budget = Math.max(box.width, box.height, 184) * 2 + gap
      const clamp = (point: CollaborationLayoutPoint) => {
        const distance = Math.hypot(point.x - original.x, point.y - original.y), factor = previous?.areaId === node.areaId && distance > budget ? budget / distance : 1
        return { x: original.x + (point.x - original.x) * factor, y: original.y + (point.y - original.y) * factor }
      }
      const target = clamp({ x: x / total, y: y / total })
      const at = (point: CollaborationLayoutPoint) => ({ ...box, x: point.x - box.width / 2, y: point.y - box.height / 2 })
      const around = { x: Math.min(current.x, target.x) - budget, y: Math.min(current.y, target.y) - budget,
        width: Math.abs(target.x - current.x) + budget * 2, height: Math.abs(target.y - current.y) + budget * 2 }
      const local = order.filter(peer => peer !== id).map(peer => placed.get(peer)!)
      const obstacles = [...fixed.query(around), ...local.filter(peer => overlap(around, peer))]
      const candidates: CollaborationLayoutPoint[] = [current, original]
      for (const fraction of [1, .5, .25]) candidates.push(clamp({ x: current.x + (target.x - current.x) * fraction, y: current.y + (target.y - current.y) * fraction }),
        clamp({ x: current.x + (target.x - current.x) * fraction, y: current.y }), clamp({ x: current.x, y: current.y + (target.y - current.y) * fraction }))
      for (const point of [...(focus.get(node.areaId) ?? [])].sort((a, b) => squared(a, current) - squared(b, current)).slice(0, 4)) candidates.push(clamp(point))
      // Facing rectangle sides yield real clear slots, rather than hoping a barycenter is free.
      for (const obstacle of obstacles.sort((a, b) => squared(center(a), target) - squared(center(b), target) || a.id.localeCompare(b.id)).slice(0, 8)) {
        candidates.push(clamp({ x: obstacle.x - gap - box.width / 2, y: target.y }), clamp({ x: obstacle.x + obstacle.width + gap + box.width / 2, y: target.y }),
          clamp({ x: target.x, y: obstacle.y - gap - box.height / 2 }), clamp({ x: target.x, y: obstacle.y + obstacle.height + gap + box.height / 2 }))
      }
      const cost = (point: CollaborationLayoutPoint) => {
        let value = displacement * squared(point, original) + compactness * squared(point, origin)
        for (const spring of edges) { const peer = placed.get(spring.source === id ? spring.target : spring.source); if (peer) value += spring.weight * squared(point, center(peer)) }
        return value
      }
      let best = current, score = cost(current)
      for (const point of candidates.slice(0, COLLABORATION_LOCAL_LAYOUT_CANDIDATES)) {
        work.candidates++
        const next = at(point), padded = { x: next.x - gap, y: next.y - gap, width: next.width + gap * 2, height: next.height + gap * 2 }
        if (fixed.query(padded).length || local.some(peer => overlap(padded, peer))
          || regionIndex.query(padded).some(region => !ancestors.get(node.areaId)!.has(region.id))) continue
        const value = cost(point)
        if (value + .01 < score) { score = value; best = point }
      }
      if (best !== current) { placed.set(id, at(best)); improved = true }
    }
    if (!improved) break
  }
}
