import type { Graph, Viz } from '@viz-js/viz'

export type CollaborationLayoutKind = 'communication' | 'creation' | 'supervision'
export type CollaborationLayoutConnection = { id: string; source: string; target: string; kind: CollaborationLayoutKind }
export type CollaborationLayoutInput = {
  areas: readonly { id: string; name: string; members: readonly string[]; folded: boolean }[]
  nodes: readonly { id: string; areaId: string; width: number; height: number }[]
  connections: readonly CollaborationLayoutConnection[]
}
export type CollaborationLayoutPoint = { x: number; y: number }
export type CollaborationLayoutBounds = { x: number; y: number; width: number; height: number }
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
async function graphviz(signal?: AbortSignal) {
  signal?.throwIfAborted()
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
const overlap = (a: CollaborationLayoutBounds, b: CollaborationLayoutBounds) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
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
  return { nodes, areas }
}
/** Finite structural work only. Every real member and cross-area endpoint participates in one solve. */
export async function arrangeCollaboration(input: CollaborationLayoutInput, signal?: AbortSignal): Promise<CollaborationLayoutBox[]> {
  signal?.throwIfAborted()
  if (!input.areas.length && !input.nodes.length) return []
  const { nodes, areas } = layoutMembers(input)
  const emptyAreas: typeof input.areas[number][] = [], occupiedAreas: typeof input.areas[number][] = []
  const clusterNames = new Map<string, string>(), usedNames = new Set([...nodes.keys(), ...areas.keys()])
  const visible = new Map<string, { id: string; width: number; height: number }>(), endpoints = new Map<string, string>()
  const graph: Graph = { directed: false,
    graphAttributes: { start: 42, overlap: 'prism', sep: `+${gap}`, splines: false, pack: gap },
    nodeAttributes: { shape: 'box', fixedsize: true, label: '', margin: 0 }, nodes: [], subgraphs: [], edges: [] }
  const labelWidth = headingWidth + padding * 2, labelHeight = COLLABORATION_AREA_HEADER + padding
  for (const area of input.areas) {
    signal?.throwIfAborted()
    const members = area.members.map(id => nodes.get(id)!)
    if (!members.length) { emptyAreas.push(area); continue }
    occupiedAreas.push(area)
    if (area.folded) {
      const shell = { id: area.id, width: 276, height: 54 }
      visible.set(shell.id, shell); graph.nodes!.push(...fixedNodes([shell]))
      endpoints.set(area.id, area.id)
      for (const member of members) endpoints.set(member.id, area.id)
      continue
    }
    let name = 'cluster_' + area.id
    while (usedNames.has(name)) name += '_'
    usedNames.add(name); clusterNames.set(area.id, name)
    for (const member of members) { visible.set(member.id, member); endpoints.set(member.id, member.id) }
    graph.subgraphs!.push({ name, graphAttributes: { margin: padding, labeljust: 'l', labelloc: 't', fontsize: 1,
      // This blank label reserves the real title, not a synthetic Agent or a relationship.
      label: { html: `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0"><TR><TD WIDTH="${labelWidth}" HEIGHT="${labelHeight}" FIXEDSIZE="TRUE"> </TD></TR></TABLE>` } }, nodes: fixedNodes(members) })
  }
  const pairs = new Set<string>()
  for (const edge of input.connections) {
    const source = endpoints.get(edge.source), target = endpoints.get(edge.target)
    if (!source || !target || source === target) continue
    const key = JSON.stringify([source, target].sort())
    if (pairs.has(key)) continue
    pairs.add(key); graph.edges!.push({ tail: source, head: target })
  }
  signal?.throwIfAborted()
  const result = occupiedAreas.length ? render(await graphviz(signal), graph, 'fdp') : { objects: [] }
  const objects = new Map((result.objects ?? []).map(item => [item.name, item]))
  const placed = new Map<string, CollaborationLayoutPoint>()
  for (const id of visible.keys()) {
    const [x, y] = (objects.get(id)?.pos ?? '').split(',').map(Number)
    if (Number.isFinite(x) && Number.isFinite(y)) placed.set(id, { x: x!, y: y! })
  }
  if (placed.size !== visible.size) throw Error('Layout did not return every original member. Existing map positions are kept.')
  const output: CollaborationLayoutBox[] = []
  for (const area of occupiedAreas) {
    signal?.throwIfAborted()
    if (area.folded) {
      const shell = visible.get(area.id)!, point = placed.get(area.id)!
      output.push({ ...shell, areaId: area.id, kind: 'area', folded: true, x: point.x - shell.width / 2, y: point.y - shell.height / 2,
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
    for (const id of area.members) {
      const node = nodes.get(id)!, point = placed.get(id)!
      output.push({ id, areaId: area.id, kind: 'agent', folded: false,
        x: point.x - node.width / 2, y: point.y - node.height / 2, width: node.width, height: node.height })
    }
  }
  // Empty original places remain discoverable without exerting force on occupied work areas.
  const occupied = output.length ? bounds(output.filter(box => box.kind === 'area').flatMap(box => [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }])) : { x: 0, y: 0, width: 0, height: 0 }
  const emptyWidth = 184, emptyHeight = 32, shelfGap = 12
  const columns = occupiedAreas.length ? Math.max(1, Math.floor((occupied.width + shelfGap) / (emptyWidth + shelfGap))) : 4
  const shelfY = occupied.y + occupied.height + (occupiedAreas.length ? gap : 0)
  for (const [index, area] of emptyAreas.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).entries()) {
    signal?.throwIfAborted()
    output.push({ id: area.id, areaId: area.id, kind: 'area', folded: area.folded,
      x: occupied.x + index % columns * (emptyWidth + shelfGap), y: shelfY + Math.floor(index / columns) * (emptyHeight + shelfGap), width: emptyWidth, height: emptyHeight,
      heading: { x: 0, y: 0, width: emptyWidth, height: emptyHeight } })
  }
  return output
}

type Obstacle = CollaborationLayoutBounds & Pick<CollaborationLayoutBox, 'id' | 'kind'>
const layoutObstacle = (original: CollaborationLayoutBox): Obstacle => original.kind === 'area'
  ? { id: original.id, kind: original.kind, x: original.x + original.heading.x, y: original.y + original.heading.y, width: original.heading.width, height: original.heading.height } : original
/** Coarse broad phase shared by this bounded route job, never a second map fact store. */
class Obstacles {
  readonly byId = new Map<string, Obstacle>()
  private cells = new Map<string, Obstacle[]>()
  extent: CollaborationLayoutBounds | null = null
  constructor(boxes: readonly CollaborationLayoutBox[]) {
    for (const original of boxes) this.add(original)
  }
  add(original: CollaborationLayoutBox) {
      const box = layoutObstacle(original)
      if (this.byId.has(box.id) || !dimension(box.width) || !dimension(box.height) || !Number.isFinite(box.x) || !Number.isFinite(box.y)) throw Error('Original fixed map geometry is inconsistent. Existing connections are kept.')
      this.byId.set(box.id, box)
      for (const key of this.keys(box)) { const values = this.cells.get(key) ?? []; values.push(box); this.cells.set(key, values) }
      this.extent = bounds([...(this.extent ? [{ x: this.extent.x, y: this.extent.y }, { x: this.extent.x + this.extent.width, y: this.extent.y + this.extent.height }] : []),
        { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }])
  }
  private *keys(box: CollaborationLayoutBounds) {
    for (let x = Math.floor(box.x / 512); x <= Math.floor((box.x + box.width) / 512); x++)
      for (let y = Math.floor(box.y / 512); y <= Math.floor((box.y + box.height) / 512); y++) yield `${x},${y}`
  }
  query(box: CollaborationLayoutBounds) {
    if (!this.extent) return []
    const x = Math.max(box.x, this.extent.x), y = Math.max(box.y, this.extent.y)
    const clipped = { x, y, width: Math.min(box.x + box.width, this.extent.x + this.extent.width) - x, height: Math.min(box.y + box.height, this.extent.y + this.extent.height) - y }
    if (clipped.width < 0 || clipped.height < 0) return []
    const result = new Set<Obstacle>()
    for (const key of this.keys(clipped)) for (const value of this.cells.get(key) ?? []) if (overlap(box, value)) result.add(value)
    return [...result]
  }
}

/** Preserve established positions. Only new or genuinely colliding geometry needs a nearby slot. */
export function reconcileCollaborationLayout(input: CollaborationLayoutInput, previous: readonly CollaborationLayoutBox[], anchor: string | null, signal?: AbortSignal): CollaborationLayoutBox[] {
  const { nodes, areas } = layoutMembers(input), held = new Map(previous.map(box => [box.id, box]))
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
  const anchored = anchor && nodes.has(anchor) && !areas.get(nodes.get(anchor)!.areaId)?.folded ? originalNode(anchor) : null
  if (anchored) place(anchored)
  const orderedAreas = [...input.areas].sort((a, b) => Number(b.id === anchor) - Number(a.id === anchor) || Number(held.has(b.id)) - Number(held.has(a.id)) || a.id.localeCompare(b.id))
  function placeTitle(area: CollaborationLayoutInput['areas'][number]) {
    const old = held.get(area.id)
    const peers = area.members.flatMap(id => (neighbors.get(id) ?? []).flatMap(peer => { const box = held.get(peer); return box ? [box] : [] }))
    const header = old?.kind === 'area' ? { x: old.x + old.heading.x, y: old.y + old.heading.y }
      : peers.length ? { x: peers.reduce((sum, box) => sum + box.x + box.width, 0) / peers.length + gap, y: peers.reduce((sum, box) => sum + box.y, 0) / peers.length } : { x: 0, y: 0 }
    const width = area.folded && area.members.length ? 276 : headingWidth, height = area.members.length ? area.folded ? 54 : COLLABORATION_AREA_HEADER : 32
    const title = place({ id: area.id, areaId: area.id, kind: 'area', folded: area.folded, ...header, width, height, heading: { x: 0, y: 0, width, height } })
    headings.set(area.id, { x: title.x, y: title.y, width, height })
  }
  for (const area of orderedAreas) if (held.get(area.id)?.kind === 'area') placeTitle(area)
  const visible = input.nodes.filter(node => !areas.get(node.areaId)!.folded && node.id !== anchored?.id)
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
  for (const area of input.areas) {
    const title = headings.get(area.id)!, members = area.folded ? [] : area.members.map(id => placed.get(id)!)
    if (!members.length) { output.push(placed.get(area.id)!); continue }
    const extent = bounds([title, ...members].flatMap(box => [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }]))
    output.push({ id: area.id, areaId: area.id, kind: 'area', folded: false, x: extent.x - padding, y: extent.y - padding, width: extent.width + padding * 2, height: extent.height + padding * 2,
      heading: { ...title, x: title.x - extent.x + padding, y: title.y - extent.y + padding } }, ...members)
  }
  return output
}
const expand = (box: CollaborationLayoutBounds, amount: number) => ({ x: box.x - amount, y: box.y - amount, width: box.width + amount * 2, height: box.height + amount * 2 })
function routeNode(box: Obstacle) {
  return { name: box.id, attributes: { pos: `${box.x + box.width / 2},${-box.y - box.height / 2}!`, width: box.width / 72, height: box.height / 72 } }
}
type PortSide = 'left' | 'right' | 'top' | 'bottom'
function pointAt(box: Obstacle, kind: CollaborationLayoutKind, outgoing: boolean, side: PortSide) {
  // Facing sides use the same physical slot for one direction, so reciprocal
  // curves remain parallel instead of swapping lanes halfway between neighbors.
  const fraction = (kinds.indexOf(kind) * 2 + (outgoing === (side === 'right' || side === 'bottom') ? .5 : 1.5)) / 6
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
async function route(obstacles: Obstacles, connection: CollaborationLayoutConnection, signal?: AbortSignal): Promise<CollaborationPath> {
  const source = obstacles.byId.get(connection.source), target = obstacles.byId.get(connection.target)
  if (!source || !target || source.id === target.id) throw Error('The original connection endpoints are unavailable. Its source remains readable.')
  const dxCenter = target.x + target.width / 2 - source.x - source.width / 2
  const dyCenter = target.y + target.height / 2 - source.y - source.height / 2
  // Prefer the larger free corridor between bodies, rather than the aspect ratio of a wide card.
  const vertical = Math.abs(dyCenter) - (source.height + target.height) / 2 > Math.abs(dxCenter) - (source.width + target.width) / 2
  const forward = vertical ? dyCenter > 0 : dxCenter > 0
  const sourceSide: PortSide = vertical ? forward ? 'bottom' : 'top' : forward ? 'right' : 'left'
  const targetSide: PortSide = vertical ? forward ? 'top' : 'bottom' : forward ? 'left' : 'right'
  const sourcePoint = pointAt(source, connection.kind, true, sourceSide), targetPoint = pointAt(target, connection.kind, false, targetSide)
  function projected(points: readonly CollaborationLayoutPoint[]): CollaborationPath {
    const middle = Math.floor((points.length - 1) / 6) * 3, segment = points.slice(middle, middle + 4)
    return { id: connection.id, path: cubicPath(points), points, bounds: bounds(points),
      sourceHandle: `${connection.kind}-out-${sourceSide}`, targetHandle: `${connection.kind}-in-${targetSide}`,
      labelX: (segment[0]!.x + 3 * segment[1]!.x + 3 * segment[2]!.x + segment[3]!.x) / 8,
      labelY: (segment[0]!.y + 3 * segment[1]!.y + 3 * segment[2]!.y + segment[3]!.y) / 8 }
  }
  const tangent = Math.max(8, Math.abs(vertical ? targetPoint.y - sourcePoint.y : targetPoint.x - sourcePoint.x) * .45) * (forward ? 1 : -1)
  const direct = [sourcePoint, { x: sourcePoint.x + (vertical ? 0 : tangent), y: sourcePoint.y + (vertical ? tangent : 0) },
    { x: targetPoint.x - (vertical ? 0 : tangent), y: targetPoint.y - (vertical ? tangent : 0) }, targetPoint]
  const selected = new Set(obstacles.query(expand(bounds(direct), 8)).filter(box => box.id !== source.id && box.id !== target.id && crosses(direct, expand(box, 8))))
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
  const obstacles = new Obstacles(boxes), output: CollaborationPath[] = []
  for (const [index, connection] of connections.entries()) {
    options.signal?.throwIfAborted()
    try { const path = await route(obstacles, connection, options.signal); output.push(path); options.onPath?.(path) }
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
