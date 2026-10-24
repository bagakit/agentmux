import type { Graph, Subgraph, Viz } from '@viz-js/viz'
import { CollaborationBoundsIndex, collaborationBoundsOverlap as overlap, type CollaborationBounds } from './collaboration-spatial-index'

export type CollaborationLayoutKind = 'communication' | 'creation' | 'supervision'
export type CollaborationLayoutConnection = { id: string; source: string; target: string; kind: CollaborationLayoutKind; strength?: number }
export type CollaborationLayoutInput = {
  areas: readonly { id: string; name: string; members: readonly string[]; folded: boolean; parentId?: string | null }[]
  nodes: readonly { id: string; areaId: string; width: number; height: number }[]
  connections: readonly CollaborationLayoutConnection[]
}
export type CollaborationLayoutPoint = { x: number; y: number }
export type CollaborationLayoutBounds = CollaborationBounds
export type CollaborationLayoutBox = CollaborationLayoutBounds & { id: string; areaId: string; folded: boolean } & (
  | { kind: 'agent' }
  | { kind: 'area'; heading: CollaborationLayoutBounds }
)
export type CollaborationPath = {
  id: string; path: string; labelX: number; labelY: number; sourceHandle: string; targetHandle: string
  bounds: CollaborationLayoutBounds; points: readonly CollaborationLayoutPoint[]
}
export type CollaborationLayoutRequest =
  | { id: string; type: 'arrange'; input: CollaborationLayoutInput }
  | { id: string; type: 'reconcile'; input: CollaborationLayoutInput; boxes: readonly CollaborationLayoutBox[]; paths: readonly CollaborationPath[]; anchor: string | null }
  | { id: string; type: 'route'; boxes: readonly CollaborationLayoutBox[]; connections: readonly CollaborationLayoutConnection[] }
export type CollaborationLayoutResponse =
  | { id: string; type: 'boxes'; boxes: CollaborationLayoutBox[]; retainedPaths?: readonly string[] }
  | { id: string; type: 'paths'; paths: Record<string, CollaborationPath> }
  | { id: string; type: 'error'; message: string; connectionId?: string }
  | { id: string; type: 'complete' }

export const COLLABORATION_AREA_HEADER = 40
const padding = 24, gap = 28, headingWidth = 184
const kinds = ['communication', 'creation', 'supervision'] as const
let engine: Promise<Viz> | undefined
async function graphviz(signal?: AbortSignal, fresh = false) {
  signal?.throwIfAborted()
  if (fresh) engine = undefined
  engine ??= import('@viz-js/viz').then(module => module.instance()).catch(error => { engine = undefined; throw error })
  const viz = await engine
  signal?.throwIfAborted()
  return viz
}
type Draw = { op: string; points?: number[][] }
type RenderedGraph = { objects?: { name: string; pos?: string; bb?: string; lp?: string }[]; edges?: { id?: string; _draw_?: Draw[] }[] }
function render(viz: Viz, graph: Graph, layout: string): RenderedGraph {
  try { return viz.renderJSON(graph, { engine: layout, yInvert: true }) as RenderedGraph }
  catch (error) { engine = undefined; throw error }
}
const dimension = (value: number) => Number.isFinite(value) && value > 0
function bounds(points: readonly CollaborationLayoutPoint[]): CollaborationLayoutBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw Error('Layout returned an invalid coordinate. Existing map positions are kept.')
    left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}
function cubicPath(points: readonly CollaborationLayoutPoint[]) {
  const commands = [`M ${points[0]!.x} ${points[0]!.y}`]
  for (let index = 1; index < points.length; index += 3) commands.push(`C ${points.slice(index, index + 3).map(point => `${point.x} ${point.y}`).join(' ')}`)
  return commands.join(' ')
}
/** Translate a completed projection without invoking WASM or changing its original identity or role. */
export function translateCollaborationPath(path: CollaborationPath, offset: CollaborationLayoutPoint): CollaborationPath {
  if (!offset.x && !offset.y) return path
  const points = path.points.map(point => ({ x: point.x + offset.x, y: point.y + offset.y }))
  return { ...path, path: cubicPath(points), points, labelX: path.labelX + offset.x, labelY: path.labelY + offset.y,
    bounds: { ...path.bounds, x: path.bounds.x + offset.x, y: path.bounds.y + offset.y } }
}
function fixedNodes(nodes: readonly { id: string; width: number; height: number }[]) {
  return nodes.map(node => ({ name: node.id, attributes: { width: node.width / 72, height: node.height / 72 } }))
}
function layoutMembers(input: CollaborationLayoutInput) {
  const nodes = new Map(input.nodes.map(node => [node.id, node])), areas = new Map(input.areas.map(area => [area.id, area]))
  const seen = new Set<string>()
  if (nodes.size !== input.nodes.length || areas.size !== input.areas.length || input.nodes.some(node => areas.has(node.id) || !dimension(node.width) || !dimension(node.height)))
    throw Error('Original map identities or dimensions are inconsistent. Existing map positions are kept.')
  for (const area of input.areas) for (const id of area.members) {
    const node = nodes.get(id)
    if (!node || node.areaId !== area.id || seen.has(id)) throw Error('Original area membership is inconsistent. Existing map positions are kept.')
    seen.add(id)
  }
  if (seen.size !== nodes.size) throw Error('Some original members have no original area. Existing map positions are kept.')
  const children = new Map<string | null, typeof input.areas[number][]>()
  for (const area of input.areas) {
    if (area.parentId && !areas.has(area.parentId)) throw Error('An original parent area is unavailable. Existing map positions are kept.')
    const siblings = children.get(area.parentId ?? null) ?? []; siblings.push(area); children.set(area.parentId ?? null, siblings)
    const ancestors = new Set([area.id])
    let parent = area.parentId
    while (parent) {
      if (ancestors.has(parent)) throw Error('Original map containment is inconsistent. Existing map positions are kept.')
      ancestors.add(parent); parent = areas.get(parent)?.parentId
    }
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.id.localeCompare(b.id))
  const hidden = (area: typeof input.areas[number]) => {
    let parent = area.parentId ? areas.get(area.parentId) : undefined
    while (parent) { if (parent.folded) return true; parent = parent.parentId ? areas.get(parent.parentId) : undefined }
    return false
  }
  return { nodes, areas, children, hidden }
}
/** One compound solve: exact occurrences stay in real containment, springs live at their LCA. */
export async function arrangeCollaboration(input: CollaborationLayoutInput, signal?: AbortSignal): Promise<CollaborationLayoutBox[]> {
  signal?.throwIfAborted()
  if (!input.areas.length && !input.nodes.length) return []
  const { nodes, areas, children } = layoutMembers(input)
  const emptyAreas: typeof input.areas[number][] = [], occupiedAreas: typeof input.areas[number][] = []
  const clusterNames = new Map<string, string>(), usedNames = new Set([...nodes.keys(), ...areas.keys()])
  const clusters = new Map<string, Subgraph>()
  const visible = new Map<string, { id: string; width: number; height: number }>(), endpoints = new Map<string, string>()
  const graph: Graph = { directed: false,
    graphAttributes: { start: 42, overlap: 'prism', sep: '+' + gap, splines: false, pack: gap },
    nodeAttributes: { shape: 'box', fixedsize: true, label: '', margin: 0 }, nodes: [], subgraphs: [], edges: [] }
  const labelWidth = headingWidth + padding * 2, labelHeight = COLLABORATION_AREA_HEADER + padding
  const counts = new Map<string, number>()
  const memberCount = (area: typeof input.areas[number]): number => {
    if (counts.has(area.id)) return counts.get(area.id)!
    const value = area.members.length + (children.get(area.id) ?? []).reduce((total, child) => total + memberCount(child), 0)
    counts.set(area.id, value); return value
  }
  function addArea(area: typeof input.areas[number], owner: Graph | Subgraph) {
    signal?.throwIfAborted()
    const members = area.members.map(id => nodes.get(id)!).sort((a, b) => a.id.localeCompare(b.id))
    occupiedAreas.push(area)
    if (area.folded || !members.length && !children.get(area.id)?.length) {
      const shell = { id: area.id, width: memberCount(area) ? 276 : 184, height: memberCount(area) ? 54 : 32 }
      visible.set(shell.id, shell); owner.nodes!.push(...fixedNodes([shell]))
      const hideMembers = (current: typeof area) => {
        endpoints.set(current.id, area.id)
        for (const id of current.members) endpoints.set(id, area.id)
        for (const child of children.get(current.id) ?? []) hideMembers(child)
      }
      hideMembers(area); return
    }
    let name = 'cluster_' + area.id
    while (usedNames.has(name)) name += '_'
    usedNames.add(name); clusterNames.set(area.id, name)
    for (const member of members) { visible.set(member.id, member); endpoints.set(member.id, member.id) }
    const cluster: Subgraph = { name, graphAttributes: { margin: padding, labeljust: 'l', labelloc: 't', fontsize: 1,
      // Reserve the actual heading without manufacturing an Agent or a relationship.
      label: { html: '<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0"><TR><TD WIDTH="' + labelWidth + '" HEIGHT="' + labelHeight + '" FIXEDSIZE="TRUE"> </TD></TR></TABLE>' } }, nodes: fixedNodes(members), edges: [], subgraphs: [] }
    clusters.set(area.id, cluster); owner.subgraphs!.push(cluster)
    for (const child of children.get(area.id) ?? []) addArea(child, cluster)
  }
  for (const area of children.get(null) ?? []) {
    if (!memberCount(area)) { emptyAreas.push(area); continue }
    addArea(area, graph)
  }
  type Spring = { source: string; target: string; messages: number; other: number }
  const pairs = new Map<string, Spring>()
  for (const edge of [...input.connections].sort((a, b) => a.id.localeCompare(b.id))) {
    const source = endpoints.get(edge.source), target = endpoints.get(edge.target)
    if (!source || !target || source === target) continue
    const [from, to] = [source, target].sort(), key = JSON.stringify([from, to])
    const pair = pairs.get(key) ?? { source: from!, target: to!, messages: 0, other: 1 }
    const strength = Number.isFinite(edge.strength) && edge.strength! >= 1 ? edge.strength! : 1
    if (edge.kind === 'communication') pair.messages += strength
    else pair.other = Math.max(pair.other, strength)
    pairs.set(key, pair)
  }
  const ancestors = (id: string) => {
    const values: string[] = []
    let parent = nodes.get(id)?.areaId ?? areas.get(id)?.parentId
    while (parent) { values.push(parent); parent = areas.get(parent)?.parentId }
    return values
  }
  for (const pair of pairs.values()) {
    const targetAncestors = new Set(ancestors(pair.target)), areaId = ancestors(pair.source).find(id => targetAncestors.has(id))
    const cluster = areaId ? clusters.get(areaId) : undefined
    // Original messages count once; their dispatch overlay never strengthens the same spring again.
    const strength = Math.min(6, Math.log2(Math.max(1, pair.messages || pair.other)))
    ;(cluster ?? graph).edges!.push({ tail: pair.source, head: pair.target, attributes: { weight: 1 + strength * 2, len: .3 / (1 + strength * .45) } })
  }
  const result = occupiedAreas.length ? render(await graphviz(signal, true), graph, 'fdp') : { objects: [] }
  const objects = new Map((result.objects ?? []).map(item => [item.name, item]))
  const placed = new Map<string, CollaborationLayoutPoint>()
  for (const id of visible.keys()) {
    const [x, y] = (objects.get(id)?.pos ?? '').split(',').map(Number)
    if (Number.isFinite(x) && Number.isFinite(y)) placed.set(id, { x: x!, y: y! })
  }
  if (placed.size !== visible.size) throw Error('Layout did not return every original member. Existing map positions are kept.')
  // fdp removes rectangle overlaps after its spring solve. Refine identity-to-slot
  // assignment within equal-size siblings so that this final packing still respects
  // strong communication. Swaps cannot change any footprint, containment or heading.
  const incident = new Map<string, Spring[]>()
  for (const pair of pairs.values()) for (const id of [pair.source, pair.target]) {
    const values = incident.get(id) ?? []; values.push(pair); incident.set(id, values)
  }
  const slots = new Map<string, string[]>()
  for (const node of input.nodes) if (placed.has(node.id) && incident.has(node.id)) {
    const key = JSON.stringify([node.areaId, node.width, node.height]), values = slots.get(key) ?? []
    values.push(node.id); slots.set(key, values)
  }
  for (const [, members] of [...slots].sort(([a], [b]) => a.localeCompare(b))) {
    members.sort()
    for (let pass = 0; pass < 2; pass++) {
      let improved = false
      for (let left = 0; left < members.length; left++) for (let right = left + 1; right < members.length; right++) {
        signal?.throwIfAborted()
        const a = members[left]!, b = members[right]!, from = placed.get(a)!, to = placed.get(b)!
        const related = new Set([...(incident.get(a) ?? []), ...(incident.get(b) ?? [])])
        const cost = (swapped: boolean) => {
          let value = 0
          const at = (id: string) => swapped && id === a ? to : swapped && id === b ? from : placed.get(id)!
          for (const pair of related) {
            const source = at(pair.source), target = at(pair.target)
            value += (1 + Math.min(6, Math.log2(Math.max(1, pair.messages || pair.other))) * 2) * Math.hypot(source.x - target.x, source.y - target.y)
          }
          return value
        }
        if (cost(true) + .01 < cost(false)) { placed.set(a, to); placed.set(b, from); improved = true }
      }
      if (!improved) break
    }
  }
  const output: CollaborationLayoutBox[] = []
  for (const area of occupiedAreas) {
    signal?.throwIfAborted()
    if (visible.has(area.id)) {
      const shell = visible.get(area.id)!, point = placed.get(area.id)!
      output.push({ ...shell, areaId: area.id, kind: 'area', folded: area.folded, x: point.x - shell.width / 2, y: point.y - shell.height / 2,
        heading: { x: 0, y: 0, width: shell.width, height: shell.height } })
      continue
    }
    const cluster = objects.get(clusterNames.get(area.id)!)
    const [left, bottom, right, top] = (cluster?.bb ?? '').split(',').map(Number)
    const [labelX, labelY] = (cluster?.lp ?? '').split(',').map(Number)
    if (![left, bottom, right, top, labelX, labelY].every(value => Number.isFinite(value)))
      throw Error('Layout did not return an original area or its title. Existing map positions are kept.')
    const x = Math.min(left!, right!), y = Math.min(top!, bottom!), width = Math.abs(right! - left!), height = Math.abs(bottom! - top!)
    const heading = { x: labelX! - x - labelWidth / 2 + padding, y: labelY! - y - labelHeight / 2 + padding,
      width: headingWidth, height: COLLABORATION_AREA_HEADER }
    output.push({ id: area.id, areaId: area.id, kind: 'area', folded: false, x, y, width, height, heading })
    for (const id of [...area.members].sort()) {
      const node = nodes.get(id)!, point = placed.get(id)!
      output.push({ id, areaId: area.id, kind: 'agent', folded: false,
        x: point.x - node.width / 2, y: point.y - node.height / 2, width: node.width, height: node.height })
    }
  }
  // Only completely empty root subtrees leave the force solve.
  const occupied = output.length ? bounds(output.filter(box => box.kind === 'area').flatMap(box => [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }])) : { x: 0, y: 0, width: 0, height: 0 }
  const emptyWidth = 184, emptyHeight = 32, shelfGap = 12
  let shelfX = occupied.x, shelfY = occupied.y + occupied.height + (occupiedAreas.length ? gap : 0), rowHeight = 0
  const shelfRight = occupied.x + (occupiedAreas.length ? Math.max(emptyWidth, occupied.width) : 4 * (emptyWidth + shelfGap))
  for (const area of emptyAreas) {
    const tree: CollaborationLayoutBox[] = []
    const emptyTree = (current: typeof area, depth: number, top: number): number => {
      const descendants = current.folded ? [] : children.get(current.id) ?? []
      const heading = { x: descendants.length ? padding : 0, y: descendants.length ? padding : 0, width: emptyWidth, height: emptyHeight }
      const box: Extract<CollaborationLayoutBox, { kind: 'area' }> = { id: current.id, areaId: current.id, kind: 'area', folded: current.folded, x: depth * padding, y: top, width: emptyWidth, height: emptyHeight, heading }
      const start = tree.length; tree.push(box)
      let bottom = top + heading.y + emptyHeight
      for (const child of descendants) bottom = emptyTree(child, depth + 1, bottom + shelfGap)
      if (descendants.length) {
        box.width += padding * 2; box.height = bottom - top + padding
        for (const child of tree.slice(start + 1)) box.width = Math.max(box.width, child.x + child.width - box.x + padding)
      }
      return top + box.height
    }
    emptyTree(area, 0, 0)
    const root = tree[0]!
    if (shelfX > occupied.x && shelfX + root.width > shelfRight) { shelfX = occupied.x; shelfY += rowHeight + shelfGap; rowHeight = 0 }
    for (const box of tree) output.push({ ...box, x: box.x + shelfX, y: box.y + shelfY })
    shelfX += root.width + shelfGap; rowHeight = Math.max(rowHeight, root.height)
  }
  return output
}

type Obstacle = CollaborationLayoutBounds & Pick<CollaborationLayoutBox, 'id' | 'kind'>
const layoutObstacle = (original: CollaborationLayoutBox): Obstacle => original.kind === 'area'
  ? { id: original.id, kind: original.kind, x: original.x + original.heading.x, y: original.y + original.heading.y, width: original.heading.width, height: original.heading.height } : original
/** The routing owner validates original geometry and projects area titles before indexing. */
class Obstacles {
  readonly byId = new Map<string, Obstacle>()
  private index = new CollaborationBoundsIndex<Obstacle>([])
  get extent() { return this.index.extent }
  constructor(boxes: readonly CollaborationLayoutBox[]) { for (const box of boxes) this.add(box) }
  add(original: CollaborationLayoutBox) {
    const box = layoutObstacle(original)
    if (this.byId.has(box.id) || !dimension(box.width) || !dimension(box.height) || !Number.isFinite(box.x) || !Number.isFinite(box.y)) throw Error('Original fixed map geometry is inconsistent. Existing connections are kept.')
    this.byId.set(box.id, box); this.index.add(box)
  }
  query(box: CollaborationLayoutBounds) { return this.index.query(box) }
}

/** Preserve established positions. Only new or genuinely colliding geometry needs a nearby slot. */
export function reconcileCollaborationLayout(input: CollaborationLayoutInput, previous: readonly CollaborationLayoutBox[], anchor: string | null, signal?: AbortSignal): CollaborationLayoutBox[] {
  const { nodes, areas, children, hidden } = layoutMembers(input), held = new Map(previous.map(box => [box.id, box]))
  const occupied = new Obstacles([]), placed = new Map<string, CollaborationLayoutBox>()
  const headings = new Map<string, CollaborationLayoutBounds>()
  const neighbors = new Map<string, string[]>()
  for (const connection of input.connections) {
    for (const [from, to] of [[connection.source, connection.target], [connection.target, connection.source]]) {
      const peers = neighbors.get(from!) ?? []; peers.push(to!); neighbors.set(from!, peers)
    }
  }
  function place(box: CollaborationLayoutBox) {
    signal?.throwIfAborted()
    let candidate = box
    if (occupied.query(expand(box, gap / 2)).length) {
      const stepX = box.width + gap, stepY = box.height + gap, extent = occupied.extent!
      // A ring beyond the finite occupied extent must contain a free slot.
      const rings = Math.ceil(Math.max(Math.abs(extent.x - box.x), Math.abs(extent.x + extent.width - box.x)) / stepX
        + Math.max(Math.abs(extent.y - box.y), Math.abs(extent.y + extent.height - box.y)) / stepY) + 2
      search: for (let ring = 1; ring <= rings; ring++) {
        signal?.throwIfAborted()
        const offsets: CollaborationLayoutPoint[] = []
        for (let index = -ring; index <= ring; index++) {
          offsets.push({ x: index, y: -ring }, { x: index, y: ring })
          if (Math.abs(index) !== ring) offsets.push({ x: -ring, y: index }, { x: ring, y: index })
        }
        offsets.sort((a, b) => (a.x * stepX) ** 2 + (a.y * stepY) ** 2 - (b.x * stepX) ** 2 - (b.y * stepY) ** 2)
        for (const offset of offsets) {
          const next = { ...box, x: box.x + offset.x * stepX, y: box.y + offset.y * stepY }
          if (!occupied.query(expand(next, gap / 2)).length) { candidate = next; break search }
        }
      }
    }
    occupied.add(candidate); placed.set(candidate.id, candidate)
    return candidate
  }
  function originalNode(id: string) {
    const node = nodes.get(id)!, old = held.get(id)
    if (old?.kind !== 'agent' || old.areaId !== node.areaId) return null
    return { ...old, width: node.width, height: node.height,
      x: old.x + (old.width - node.width) / 2, y: old.y + (old.height - node.height) / 2 }
  }
  // The actual reading occurrence goes first, before its newly expanded body can displace it.
  const anchored = anchor && nodes.has(anchor) && !areas.get(nodes.get(anchor)!.areaId)?.folded && !hidden(areas.get(nodes.get(anchor)!.areaId)!) ? originalNode(anchor) : null
  if (anchored) place(anchored)
  const orderedAreas = input.areas.filter(area => !hidden(area)).sort((a, b) => Number(b.id === anchor) - Number(a.id === anchor) || Number(held.has(b.id)) - Number(held.has(a.id)) || a.id.localeCompare(b.id))
  function placeTitle(area: CollaborationLayoutInput['areas'][number]) {
    const old = held.get(area.id)
    const peers = area.members.flatMap(id => (neighbors.get(id) ?? []).flatMap(peer => { const box = held.get(peer); return box ? [box] : [] }))
    const parent = area.parentId ? held.get(area.parentId) : undefined
    const child = (children.get(area.id) ?? []).map(value => held.get(value.id)).find(Boolean)
    const header = old?.kind === 'area' ? { x: old.x + old.heading.x, y: old.y + old.heading.y }
      : child ? { x: child.x, y: child.y - COLLABORATION_AREA_HEADER - gap }
      : peers.length ? { x: peers.reduce((sum, box) => sum + box.x + box.width, 0) / peers.length + gap, y: peers.reduce((sum, box) => sum + box.y, 0) / peers.length }
      : parent?.kind === 'area' ? { x: parent.x + parent.heading.x, y: parent.y + parent.heading.y + parent.heading.height + gap } : { x: 0, y: 0 }
    const hasContent = area.members.length > 0 || Boolean(children.get(area.id)?.length)
    const width = area.folded && hasContent ? 276 : headingWidth, height = hasContent ? area.folded ? 54 : COLLABORATION_AREA_HEADER : 32
    const title = place({ id: area.id, areaId: area.id, kind: 'area', folded: area.folded, ...header, width, height, heading: { x: 0, y: 0, width, height } })
    headings.set(area.id, { x: title.x, y: title.y, width, height })
  }
  for (const area of orderedAreas) if (held.get(area.id)?.kind === 'area') placeTitle(area)
  const visible = input.nodes.filter(node => !areas.get(node.areaId)!.folded && !hidden(areas.get(node.areaId)!) && node.id !== anchored?.id)
  visible.sort((a, b) => {
    const left = held.get(a.id), right = held.get(b.id)
    const rank = (node: typeof a, old: CollaborationLayoutBox | undefined) => old?.kind === 'agent' && !held.get(node.areaId)?.folded ? old.width === node.width && old.height === node.height ? 0 : 1 : 2
    return rank(a, left) - rank(b, right) || a.id.localeCompare(b.id)
  })
  const retained = visible.filter(node => originalNode(node.id)), added = visible.filter(node => !originalNode(node.id))
  for (const node of retained) place(originalNode(node.id)!)
  // A newly discovered place must yield to every established member, not claim its old position.
  for (const area of orderedAreas) if (held.get(area.id)?.kind !== 'area') placeTitle(area)
  for (const node of added) {
    let box = originalNode(node.id)
    if (!box) {
      const related = (neighbors.get(node.id) ?? []).filter(id => nodes.get(id)?.areaId === node.areaId)
      const local = related.length ? related : areas.get(node.areaId)!.members.filter(id => id !== node.id)
      const peers = local.flatMap(id => { const value = placed.get(id) ?? held.get(id); return value ? [value] : [] })
      const title = headings.get(node.areaId)!
      const point = peers.length ? { x: peers.reduce((sum, peer) => sum + peer.x + peer.width / 2, 0) / peers.length - node.width / 2,
        y: peers.reduce((sum, peer) => sum + peer.y + peer.height / 2, 0) / peers.length + gap } : { x: title.x, y: title.y + title.height + gap }
      box = { ...node, ...point, kind: 'agent', folded: false }
    }
    place(box)
  }
  const output: CollaborationLayoutBox[] = []
  const enclose = (area: typeof input.areas[number]): CollaborationLayoutBox => {
    const title = headings.get(area.id)!, members = area.folded ? [] : area.members.map(id => placed.get(id)!)
    const descendants = area.folded ? [] : (children.get(area.id) ?? []).map(enclose)
    if (!members.length && !descendants.length) { const box = placed.get(area.id)!; output.push(box); return box }
    const extent = bounds([title, ...members, ...descendants].flatMap(box => [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }]))
    const box: CollaborationLayoutBox = { id: area.id, areaId: area.id, kind: 'area', folded: false, x: extent.x - padding, y: extent.y - padding, width: extent.width + padding * 2, height: extent.height + padding * 2,
      heading: { ...title, x: title.x - extent.x + padding, y: title.y - extent.y + padding } }
    output.push(box, ...members); return box
  }
  for (const area of children.get(null) ?? []) enclose(area)
  return output
}
const expand = (box: CollaborationLayoutBounds, amount: number) => ({ x: box.x - amount, y: box.y - amount, width: box.width + amount * 2, height: box.height + amount * 2 })
function routeNode(box: Obstacle) {
  return { name: box.id, attributes: { pos: `${box.x + box.width / 2},${-box.y - box.height / 2}!`, width: box.width / 72, height: box.height / 72 } }
}
type PortSide = 'left' | 'right' | 'top' | 'bottom'
function pointAt(box: Obstacle, peer: Obstacle, kind: CollaborationLayoutKind, outgoing: boolean, side: PortSide) {
  // Facing sides use the same physical slot for one direction, so reciprocal
  // curves remain parallel instead of swapping lanes halfway between neighbors.
  const vertical = side === 'top' || side === 'bottom'
  const dx = peer.x + peer.width / 2 - box.x - box.width / 2, dy = peer.y + peer.height / 2 - box.y - box.height / 2
  // Bearing gives a stable, ordered fan-out independent of arrival batches.
  // The same physical lane is used at both facing ends, including reciprocal roles.
  const bearing = Math.atan2(vertical ? dx : dy, Math.abs(vertical ? dy : dx)) / Math.PI
  const radial = .1 * (1 - Math.exp(-Math.hypot(dx, dy) / 512))
  const fraction = (kinds.indexOf(kind) * 2 + (outgoing === (side === 'right' || side === 'bottom') ? .5 : 1.5) + bearing * .8 + radial) / 6
  return side === 'top' || side === 'bottom'
    ? { x: box.x + fraction * box.width, y: box.y + (side === 'bottom' ? box.height : 0) }
    : { x: box.x + (side === 'right' ? box.width : 0), y: box.y + fraction * box.height }
}
const midpoint = (a: CollaborationLayoutPoint, b: CollaborationLayoutPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
/** Conservative subdivision validates library output; it never invents a replacement route. */
function crosses(points: readonly CollaborationLayoutPoint[], obstacle: CollaborationLayoutBounds, depth = 0): boolean {
  if (!overlap(bounds(points), obstacle)) return false
  if (points.every(point => point.x > obstacle.x && point.x < obstacle.x + obstacle.width && point.y > obstacle.y && point.y < obstacle.y + obstacle.height)) return true
  if (depth === 14) return true
  const [a, b, c, d] = points as [CollaborationLayoutPoint, CollaborationLayoutPoint, CollaborationLayoutPoint, CollaborationLayoutPoint]
  const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d), abc = midpoint(ab, bc), bcd = midpoint(bc, cd), middle = midpoint(abc, bcd)
  return crosses([a, ab, abc, middle], obstacle, depth + 1) || crosses([middle, bcd, cd, d], obstacle, depth + 1)
}
function sampleCurve(points: readonly CollaborationLayoutPoint[]) {
  const samples: CollaborationLayoutPoint[] = [points[0]!]
  for (let segment = 0; segment < points.length - 1; segment += 3) {
    const [a, b, c, d] = points.slice(segment, segment + 4) as [CollaborationLayoutPoint, CollaborationLayoutPoint, CollaborationLayoutPoint, CollaborationLayoutPoint]
    for (let index = 1; index <= 12; index++) {
      const t = index / 12, u = 1 - t
      samples.push({ x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
        y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y })
    }
  }
  return samples
}
class RoutedChannels {
  private index = new CollaborationBoundsIndex<CollaborationLayoutBounds & { key: string; points: readonly CollaborationLayoutPoint[] }>([])
  private seen = new Set<string>()
  private key(connection: CollaborationLayoutConnection) { return JSON.stringify([connection.kind, connection.source, connection.target]) }
  add(path: CollaborationPath, connection: CollaborationLayoutConnection) {
    const key = this.key(connection)
    if (this.seen.has(key)) return
    this.seen.add(key); this.index.add({ ...path.bounds, key, points: sampleCurve(path.points) })
  }
  crossings(curve: readonly CollaborationLayoutPoint[], connection: CollaborationLayoutConnection) {
    const points = sampleCurve(curve), key = this.key(connection)
    const orient = (a: CollaborationLayoutPoint, b: CollaborationLayoutPoint, c: CollaborationLayoutPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    let count = 0
    for (const channel of this.index.query(bounds(points))) {
      if (channel.key === key) continue
      let crossing = false
      for (let left = 1; !crossing && left < points.length; left++) for (let right = 1; right < channel.points.length; right++) {
        const a = points[left - 1]!, b = points[left]!, c = channel.points[right - 1]!, d = channel.points[right]!
        if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) { crossing = true; break }
      }
      if (crossing) count++
    }
    return count
  }
}
async function route(obstacles: Obstacles, connection: CollaborationLayoutConnection, channels: RoutedChannels, signal?: AbortSignal): Promise<CollaborationPath> {
  const source = obstacles.byId.get(connection.source), target = obstacles.byId.get(connection.target)
  if (!source || !target || source.id === target.id) throw Error('The original connection endpoints are unavailable. Its source remains readable.')
  const dxCenter = target.x + target.width / 2 - source.x - source.width / 2
  const dyCenter = target.y + target.height / 2 - source.y - source.height / 2
  const preferredVertical = Math.abs(dyCenter) - (source.height + target.height) / 2 > Math.abs(dxCenter) - (source.width + target.width) / 2
  const candidate = (vertical: boolean) => {
    const forward = vertical ? dyCenter > 0 : dxCenter > 0
    const sourceSide: PortSide = vertical ? forward ? 'bottom' : 'top' : forward ? 'right' : 'left'
    const targetSide: PortSide = vertical ? forward ? 'top' : 'bottom' : forward ? 'left' : 'right'
    const sourcePoint = pointAt(source, target, connection.kind, true, sourceSide), targetPoint = pointAt(target, source, connection.kind, false, targetSide)
    const tangent = Math.max(8, Math.abs(vertical ? targetPoint.y - sourcePoint.y : targetPoint.x - sourcePoint.x) * .45) * (forward ? 1 : -1)
    const direct = [sourcePoint, { x: sourcePoint.x + (vertical ? 0 : tangent), y: sourcePoint.y + (vertical ? tangent : 0) },
      { x: targetPoint.x - (vertical ? 0 : tangent), y: targetPoint.y - (vertical ? tangent : 0) }, targetPoint]
    const selected = new Set(obstacles.query(expand(bounds(direct), 8)).filter(box => box.id !== source.id && box.id !== target.id && crosses(direct, expand(box, 8))))
    for (const endpoint of [source, target]) {
      const interior = { x: endpoint.x + .2, y: endpoint.y + .2, width: endpoint.width - .4, height: endpoint.height - .4 }
      if (crosses(direct, interior)) selected.add(endpoint)
    }
    const points = sampleCurve(direct)
    const length = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y), 0)
    const detour = [...selected].reduce((cost, box) => cost + Math.min(box.width, box.height) + gap * 2, 0)
    return { vertical, forward, sourceSide, targetSide, sourcePoint, targetPoint, direct, selected,
      cost: length + detour + channels.crossings(direct, connection) * 48 }
  }
  // Compare two genuine facing corridors before asking the library for a detour.
  const preferred = candidate(preferredVertical), alternative = candidate(!preferredVertical)
  const chosen = preferred.selected.size && alternative.cost + 16 < preferred.cost ? alternative : preferred
  const { vertical, forward, sourceSide, targetSide, sourcePoint, targetPoint, direct, selected } = chosen
  function projected(points: readonly CollaborationLayoutPoint[]): CollaborationPath {
    const middle = Math.floor((points.length - 1) / 6) * 3, segment = points.slice(middle, middle + 4)
    return { id: connection.id, path: cubicPath(points), points, bounds: bounds(points),
      sourceHandle: `${connection.kind}-out-${sourceSide}`, targetHandle: `${connection.kind}-in-${targetSide}`,
      labelX: (segment[0]!.x + 3 * segment[1]!.x + 3 * segment[2]!.x + segment[3]!.x) / 8,
      labelY: (segment[0]!.y + 3 * segment[1]!.y + 3 * segment[2]!.y + segment[3]!.y) / 8 }
  }
  // A clear pair needs one smooth curve. Only real obstructions enter the library's detour solve.
  if (!selected.size) return projected(direct)
  // Terminal stems are part of every route. Real endpoint rectangles remain obstacles too:
  // nop2's HTML compass ports otherwise permit a spline through its own endpoint body.
  const stemX = vertical ? 0 : forward ? 8 : -8, stemY = vertical ? forward ? 8 : -8 : 0
  const sourceAnchor = { x: sourcePoint.x + stemX, y: sourcePoint.y + stemY }
  const targetAnchor = { x: targetPoint.x - stemX, y: targetPoint.y - stemY }
  const anchorName = (base: string) => { let id = base; while (obstacles.byId.has(id)) id += '_'; return id }
  const sourceId = anchorName('__source_port__'), targetId = anchorName('__target_port__')
  const anchorNode = (id: string, point: CollaborationLayoutPoint) => ({ name: id, attributes: { pos: `${point.x},${-point.y}!`, shape: 'point', width: 0, height: 0 } })
  selected.add(source); selected.add(target)
  const viz = await graphviz(signal)
  for (;;) {
    signal?.throwIfAborted()
    const result = render(viz, { directed: true, graphAttributes: { notranslate: true, splines: true },
      nodeAttributes: { shape: 'box', fixedsize: true, label: '', margin: 0 },
      nodes: [...selected].map(routeNode).concat([anchorNode(sourceId, sourceAnchor), anchorNode(targetId, targetAnchor)]),
      edges: [{ tail: sourceId, head: targetId, attributes: { id: connection.id, arrowhead: 'none' } }] }, 'nop2')
    const origin = result.objects?.find(item => item.name === source.id), [x, y] = (origin?.pos ?? '').split(',').map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw Error('Connection routing lost its original coordinate system. Existing connections are kept.')
    const dx = source.x + source.width / 2 - x!, dy = source.y + source.height / 2 - y!
    for (const item of result.objects ?? []) {
      if (item.name === sourceId || item.name === targetId) continue
      const box = obstacles.byId.get(item.name), [px, py] = (item.pos ?? '').split(',').map(Number)
      if (!box || !Number.isFinite(px) || !Number.isFinite(py) || Math.abs(px! + dx - box.x - box.width / 2) > .1 || Math.abs(py! + dy - box.y - box.height / 2) > .1)
        throw Error('Connection routing moved an original fixed box. Existing connections are kept.')
    }
    const points = result.edges?.find(edge => edge.id === connection.id)?._draw_?.find(draw => draw.op === 'b')?.points?.map(point => ({ x: point[0]! + dx, y: point[1]! + dy }))
    if (!points || points.length < 4 || (points.length - 1) % 3) throw Error('The original connection curve is unavailable. Its source remains readable.')
    // Restore sub-point output rounding without moving the original fixed port anchors.
    for (const [index, adjacent, exact] of [[0, 1, sourceAnchor], [points.length - 1, points.length - 2, targetAnchor]] as const) {
      const delta = { x: exact.x - points[index]!.x, y: exact.y - points[index]!.y }
      if (Math.abs(delta.x) > 1.1 || Math.abs(delta.y) > 1.1) throw Error('Connection routing lost an original role port. Its source remains readable.')
      points[index] = exact; points[adjacent] = { x: points[adjacent]!.x + delta.x, y: points[adjacent]!.y + delta.y }
    }
    const stem = (from: CollaborationLayoutPoint, to: CollaborationLayoutPoint) => [
      { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
      { x: from.x + (to.x - from.x) * 2 / 3, y: from.y + (to.y - from.y) * 2 / 3 }, to]
    points.unshift(sourcePoint, ...stem(sourcePoint, sourceAnchor).slice(0, 2))
    points.push(...stem(targetAnchor, targetPoint))
    const extent = bounds(points), omitted = obstacles.query(expand(extent, 1)).filter(box => {
      if (selected.has(box)) return false
      const inside = { x: box.x + .2, y: box.y + .2, width: box.width - .4, height: box.height - .4 }
      for (let index = 0; index < points.length - 1; index += 3) if (crosses(points.slice(index, index + 4), inside)) return true
      return false
    })
    if (omitted.length) { for (const box of omitted) selected.add(box); continue }
    for (const box of selected) {
      const inside = { x: box.x + .2, y: box.y + .2, width: box.width - .4, height: box.height - .4 }
      for (let index = 0; index < points.length - 1; index += 3) if (crosses(points.slice(index, index + 4), inside))
        throw Error(`Connection routing crosses original ${box.kind === 'area' ? 'area heading' : 'card'} ${box.id}. Its source remains readable; retry the same connection.`)
    }
    return projected(points)
  }
}

/** Only requested new/changed connections enter WASM. Local obstacles expand until every original obstruction is covered. */
export async function routeCollaborationLayout(boxes: readonly CollaborationLayoutBox[], connections: readonly CollaborationLayoutConnection[], options: {
  signal?: AbortSignal | undefined; onPath?: (path: CollaborationPath) => void; onError?: (id: string, error: unknown) => void
} = {}): Promise<CollaborationPath[]> {
  options.signal?.throwIfAborted()
  if (!connections.length) return []
  const obstacles = new Obstacles(boxes), channels = new RoutedChannels(), output: CollaborationPath[] = []
  for (const [index, connection] of [...connections].sort((a, b) => (b.strength ?? 1) - (a.strength ?? 1) || a.id.localeCompare(b.id)).entries()) {
    options.signal?.throwIfAborted()
    try { const path = await route(obstacles, connection, channels, options.signal); channels.add(path, connection); output.push(path); options.onPath?.(path) }
    catch (error) { options.signal?.throwIfAborted(); if (!options.onError) throw error; options.onError(connection.id, error) }
    // Yield between finite library calls so a superseding generation does not start more work.
    if ((index + 1) % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  return output
}

/** The Worker and its transport tests share the real finite job, not another layout implementation. */
export async function handleCollaborationLayoutRequest(request: CollaborationLayoutRequest, publish: (response: CollaborationLayoutResponse) => void, signal?: AbortSignal): Promise<void> {
  const emit = (response: CollaborationLayoutResponse) => { if (!signal?.aborted) publish(response) }
  let pending: Record<string, CollaborationPath> = Object.create(null), size = 0
  const flush = () => { if (size) { emit({ id: request.id, type: 'paths', paths: pending }); pending = Object.create(null); size = 0 } }
  try {
    const boxes = request.type === 'arrange' ? await arrangeCollaboration(request.input, signal)
      : request.type === 'reconcile' ? reconcileCollaborationLayout(request.input, request.boxes, request.anchor, signal) : request.boxes
    let connections = request.type === 'route' ? request.connections : request.input.connections
    if (request.type === 'reconcile') {
      const previous = new Map(request.boxes.map(box => [box.id, layoutObstacle(box)])), current = new Map(boxes.map(box => [box.id, layoutObstacle(box)]))
      const same = (a: Obstacle | undefined, b: Obstacle | undefined) => a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
      const changed = [...current.values()].filter(box => !same(box, previous.get(box.id))), paths = new Map(request.paths.map(path => [path.id, path]))
      const retainedPaths = connections.filter(connection => {
        const path = paths.get(connection.id)
        return path && same(previous.get(connection.source), current.get(connection.source)) && same(previous.get(connection.target), current.get(connection.target))
          && !changed.some(box => box.id !== connection.source && box.id !== connection.target && overlap(path.bounds, box))
      }).map(connection => connection.id)
      const retained = new Set(retainedPaths)
      connections = connections.filter(connection => !retained.has(connection.id))
      emit({ id: request.id, type: 'boxes', boxes: [...boxes], retainedPaths })
    } else if (request.type === 'arrange') emit({ id: request.id, type: 'boxes', boxes: [...boxes] })
    await routeCollaborationLayout(boxes, connections, {
      signal,
      onPath: path => { pending[path.id] = path; if (++size === 8) flush() },
      onError: (connectionId, error) => { flush(); emit({ id: request.id, type: 'error', connectionId, message: error instanceof Error ? error.message : 'Connection routing failed. Its source remains readable.' }) }
    })
  } catch (error) {
    if (!signal?.aborted) emit({ id: request.id, type: 'error', message: error instanceof Error ? error.message : 'Map layout failed. Existing positions are kept.' })
  } finally { flush(); emit({ id: request.id, type: 'complete' }) }
}
