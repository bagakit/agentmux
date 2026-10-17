import type { Graph, Viz } from '@viz-js/viz'

export type CollaborationLayoutKind = 'communication' | 'creation' | 'supervision'
export type CollaborationLayoutConnection = { id: string; source: string; target: string; kind: CollaborationLayoutKind }
export type CollaborationLayoutInput = {
  areas: readonly { id: string; name: string; members: readonly string[]; folded: boolean }[]
  nodes: readonly { id: string; areaId: string; width: number; height: number }[]
  connections: readonly CollaborationLayoutConnection[]
}
export type CollaborationLayoutBox = {
  id: string; areaId: string; kind: 'area' | 'agent'; x: number; y: number; width: number; height: number; folded: boolean
}
export type CollaborationLayoutPoint = { x: number; y: number }
export type CollaborationLayoutBounds = { x: number; y: number; width: number; height: number }
export type CollaborationPath = {
  id: string; path: string; labelX: number; labelY: number; sourceHandle: string; targetHandle: string
  bounds: CollaborationLayoutBounds; points: readonly CollaborationLayoutPoint[]
}
export type CollaborationLayoutRequest =
  | { id: string; type: 'arrange'; input: CollaborationLayoutInput }
  | { id: string; type: 'route'; boxes: readonly CollaborationLayoutBox[]; connections: readonly CollaborationLayoutConnection[] }
export type CollaborationLayoutResponse =
  | { id: string; type: 'boxes'; boxes: CollaborationLayoutBox[] }
  | { id: string; type: 'paths'; paths: Record<string, CollaborationPath> }
  | { id: string; type: 'error'; message: string; connectionId?: string }
  | { id: string; type: 'complete' }

export const COLLABORATION_AREA_HEADER = 40
const padding = 24, gap = 28
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
type RenderedGraph = { objects?: { name: string; pos?: string }[]; edges?: { id?: string; _draw_?: Draw[] }[] }
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
function positions(viz: Viz, nodes: readonly { id: string; width: number; height: number }[], edges: readonly { source: string; target: string }[], layout: 'sfdp' | 'fdp') {
  if (!nodes.length) return new Map<string, CollaborationLayoutPoint>()
  const original = new Set(nodes.map(node => node.id)), pairs = new Set<string>()
  const result = render(viz, { directed: false,
    graphAttributes: { start: 42, overlap: 'prism', sep: `+${gap}`, splines: false, pack: gap },
    nodeAttributes: { shape: 'box', fixedsize: true, label: '', margin: 0 }, nodes: fixedNodes(nodes),
    edges: edges.flatMap(edge => {
      const key = JSON.stringify([edge.source, edge.target].sort())
      if (edge.source === edge.target || !original.has(edge.source) || !original.has(edge.target) || pairs.has(key)) return []
      pairs.add(key); return [{ tail: edge.source, head: edge.target }]
    }) }, layout)
  const output = new Map<string, CollaborationLayoutPoint>()
  for (const item of result.objects ?? []) {
    const [x, y] = (item.pos ?? '').split(',').map(Number)
    if (original.has(item.name) && Number.isFinite(x) && Number.isFinite(y)) output.set(item.name, { x: x!, y: y! })
  }
  if (output.size !== nodes.length) throw Error('Layout did not return every original member. Existing map positions are kept.')
  return output
}

/** Finite structural work only. The caller owns membership, size tiers, retained positions and camera. */
export async function arrangeCollaboration(input: CollaborationLayoutInput, signal?: AbortSignal): Promise<CollaborationLayoutBox[]> {
  signal?.throwIfAborted()
  if (!input.areas.length && !input.nodes.length) return []
  const nodes = new Map(input.nodes.map(node => [node.id, node]))
  const areas = new Map(input.areas.map(area => [area.id, area])), seen = new Set<string>()
  if (nodes.size !== input.nodes.length || areas.size !== input.areas.length || input.nodes.some(node => areas.has(node.id) || !dimension(node.width) || !dimension(node.height)))
    throw Error('Original map identities or dimensions are inconsistent. Existing map positions are kept.')
  const within = new Map<string, CollaborationLayoutConnection[]>(), between: { source: string; target: string }[] = []
  for (const edge of input.connections) {
    const source = nodes.get(edge.source)?.areaId ?? (areas.has(edge.source) ? edge.source : undefined)
    const target = nodes.get(edge.target)?.areaId ?? (areas.has(edge.target) ? edge.target : undefined)
    if (!source || !target) continue
    if (source === target) { const list = within.get(source) ?? []; list.push(edge); within.set(source, list) }
    else between.push({ source, target })
  }
  const viz = await graphviz(signal), local = new Map<string, CollaborationLayoutBox[]>(), groups: { id: string; width: number; height: number }[] = []
  for (const area of input.areas) {
    signal?.throwIfAborted()
    const members = area.members.map(id => {
      const node = nodes.get(id)
      if (!node || node.areaId !== area.id || seen.has(id)) throw Error('Original area membership is inconsistent. Existing map positions are kept.')
      seen.add(id); return node
    })
    if (area.folded || !members.length) {
      local.set(area.id, []); groups.push({ id: area.id, width: 276, height: members.length ? 54 : COLLABORATION_AREA_HEADER }); continue
    }
    const placed = positions(viz, members, within.get(area.id) ?? [], 'sfdp')
    const boxes = members.map(node => ({ id: node.id, areaId: area.id, kind: 'agent' as const, folded: false,
      x: placed.get(node.id)!.x - node.width / 2, y: placed.get(node.id)!.y - node.height / 2, width: node.width, height: node.height }))
    const extent = bounds(boxes.flatMap(box => [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }]))
    for (const box of boxes) { box.x += padding - extent.x; box.y += padding + COLLABORATION_AREA_HEADER - extent.y }
    local.set(area.id, boxes); groups.push({ id: area.id, width: Math.max(276, extent.width + padding * 2), height: extent.height + padding * 2 + COLLABORATION_AREA_HEADER })
  }
  if (seen.size !== nodes.size) throw Error('Some original members have no original area. Existing map positions are kept.')
  signal?.throwIfAborted()
  const arranged = positions(viz, groups, between, 'fdp'), output: CollaborationLayoutBox[] = []
  for (const group of groups) {
    const point = arranged.get(group.id)!, x = point.x - group.width / 2, y = point.y - group.height / 2
    output.push({ ...group, areaId: group.id, kind: 'area', x, y, folded: areas.get(group.id)!.folded })
    for (const box of local.get(group.id)!) output.push({ ...box, x: box.x + x, y: box.y + y })
  }
  return output
}

/** Coarse broad phase shared by this bounded route job, never a second map fact store. */
class Obstacles {
  readonly byId = new Map<string, CollaborationLayoutBox>()
  private cells = new Map<string, CollaborationLayoutBox[]>()
  private extent: CollaborationLayoutBounds
  constructor(boxes: readonly CollaborationLayoutBox[]) {
    for (const original of boxes) {
      const box = original.kind === 'area' && !original.folded ? { ...original, height: COLLABORATION_AREA_HEADER } : original
      if (this.byId.has(box.id) || !dimension(box.width) || !dimension(box.height) || !Number.isFinite(box.x) || !Number.isFinite(box.y)) throw Error('Original fixed map geometry is inconsistent. Existing connections are kept.')
      this.byId.set(box.id, box)
      for (const key of this.keys(box)) { const values = this.cells.get(key) ?? []; values.push(box); this.cells.set(key, values) }
    }
    this.extent = boxes.length ? bounds([...this.byId.values()].flatMap(box => [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }])) : { x: 0, y: 0, width: 0, height: 0 }
  }
  private *keys(box: CollaborationLayoutBounds) {
    for (let x = Math.floor(box.x / 512); x <= Math.floor((box.x + box.width) / 512); x++)
      for (let y = Math.floor(box.y / 512); y <= Math.floor((box.y + box.height) / 512); y++) yield `${x},${y}`
  }
  query(box: CollaborationLayoutBounds) {
    const x = Math.max(box.x, this.extent.x), y = Math.max(box.y, this.extent.y)
    const clipped = { x, y, width: Math.min(box.x + box.width, this.extent.x + this.extent.width) - x, height: Math.min(box.y + box.height, this.extent.y + this.extent.height) - y }
    if (clipped.width < 0 || clipped.height < 0) return []
    const result = new Set<CollaborationLayoutBox>()
    for (const key of this.keys(clipped)) for (const value of this.cells.get(key) ?? []) if (overlap(box, value)) result.add(value)
    return [...result]
  }
}
const expand = (box: CollaborationLayoutBounds, amount: number) => ({ x: box.x - amount, y: box.y - amount, width: box.width + amount * 2, height: box.height + amount * 2 })
function routeNode(box: CollaborationLayoutBox) {
  return { name: box.id, attributes: { pos: `${box.x + box.width / 2},${-box.y - box.height / 2}!`, width: box.width / 72, height: box.height / 72 } }
}
function pointAt(box: CollaborationLayoutBox, kind: CollaborationLayoutKind, outgoing: boolean, right: boolean) {
  return { x: box.x + (right ? box.width : 0), y: box.y + (kinds.indexOf(kind) * 2 + (outgoing ? .5 : 1.5)) / 6 * box.height }
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
function route(viz: Viz, obstacles: Obstacles, connection: CollaborationLayoutConnection, signal?: AbortSignal): CollaborationPath {
  const source = obstacles.byId.get(connection.source), target = obstacles.byId.get(connection.target)
  if (!source || !target || source.id === target.id) throw Error('The original connection endpoints are unavailable. Its source remains readable.')
  const forward = source.x + source.width / 2 === target.x + target.width / 2 ? source.y < target.y : source.x + source.width / 2 < target.x + target.width / 2
  const sourcePoint = pointAt(source, connection.kind, true, forward), targetPoint = pointAt(target, connection.kind, false, !forward)
  // Terminal stems are part of every route. Real endpoint rectangles remain obstacles too:
  // nop2's HTML compass ports otherwise permit a spline through its own endpoint body.
  const sourceAnchor = { x: sourcePoint.x + (forward ? 8 : -8), y: sourcePoint.y }
  const targetAnchor = { x: targetPoint.x + (forward ? -8 : 8), y: targetPoint.y }
  const anchorName = (base: string) => { let id = base; while (obstacles.byId.has(id)) id += '_'; return id }
  const sourceId = anchorName('__source_port__'), targetId = anchorName('__target_port__')
  const anchorNode = (id: string, point: CollaborationLayoutPoint) => ({ name: id, attributes: { pos: `${point.x},${-point.y}!`, shape: 'point', width: 0, height: 0 } })
  const direct = [sourceAnchor, sourceAnchor, targetAnchor, targetAnchor]
  const selected = new Set(obstacles.query(expand(bounds(direct), 64)).filter(box => crosses(direct, expand(box, 64))))
  selected.add(source); selected.add(target)
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
    const middle = Math.floor((points.length - 1) / 6) * 3, segment = points.slice(middle, middle + 4)
    return { id: connection.id, path: cubicPath(points), points, bounds: extent,
      sourceHandle: `${connection.kind}-out-${forward ? 'right' : 'left'}`, targetHandle: `${connection.kind}-in-${forward ? 'left' : 'right'}`,
      labelX: (segment[0]!.x + 3 * segment[1]!.x + 3 * segment[2]!.x + segment[3]!.x) / 8,
      labelY: (segment[0]!.y + 3 * segment[1]!.y + 3 * segment[2]!.y + segment[3]!.y) / 8 }
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
    try { const path = route(await graphviz(options.signal), obstacles, connection, options.signal); output.push(path); options.onPath?.(path) }
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
    const boxes = request.type === 'arrange' ? await arrangeCollaboration(request.input, signal) : request.boxes
    if (request.type === 'arrange') emit({ id: request.id, type: 'boxes', boxes: [...boxes] })
    await routeCollaborationLayout(boxes, request.type === 'arrange' ? request.input.connections : request.connections, {
      signal,
      onPath: path => { pending[path.id] = path; if (++size === 8) flush() },
      onError: (connectionId, error) => { flush(); emit({ id: request.id, type: 'error', connectionId, message: error instanceof Error ? error.message : 'Connection routing failed. Its source remains readable.' }) }
    })
  } catch (error) {
    if (!signal?.aborted) emit({ id: request.id, type: 'error', message: error instanceof Error ? error.message : 'Map layout failed. Existing positions are kept.' })
  } finally { flush(); emit({ id: request.id, type: 'complete' }) }
}
