import type { CollaborationRelation } from './agent-collaboration'
import { collaborationInnerX, collaborationPort, collaborationPortPoint, type CollaborationBox, type CollaborationPoint, type CollaborationSide } from './collaboration-geometry'

export type CollaborationConnection = { id: string; source: string; target: string; kind: CollaborationRelation['kind'] }
export type CollaborationPath = {
  path: string; labelX: number; labelY: number; sourceHandle: string; targetHandle: string
  bounds: { x: number; y: number; width: number; height: number }
  points: readonly CollaborationPoint[]
}
const lanes = { communication: -3, creation: 0, supervision: 3 } as const

/** Each endpoint escapes only its own fixed cell into the layout's reserved streets. */
function escape(box: CollaborationBox, kind: CollaborationRelation['kind'], direction: 'in' | 'out', side: CollaborationSide, lane: number) {
  const point = collaborationPortPoint(box, kind, direction, side), street = 608 + lane
  if (box.kind === 'area' || box.column !== box.cardColumn) return [point, { x: street, y: point.y }]
  const inner = collaborationInnerX(box) + lane, gutter = box.y + box.height + 7 + lane / 2
  return [point, { x: inner, y: point.y }, { x: inner, y: gutter }, { x: street, y: gutter }]
}

/** Rounded SVG corners stay inside the original empty orthogonal corridor. */
function rounded(points: readonly CollaborationPoint[]) {
  const first = points[0]!, commands = [`M ${first.x} ${first.y}`]
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!, at = points[index]!, next = points[index + 1]!
    const incoming = Math.hypot(at.x - previous.x, at.y - previous.y), outgoing = Math.hypot(next.x - at.x, next.y - at.y)
    const radius = Math.min(3, incoming / 2, outgoing / 2)
    if (!radius) continue
    const before = { x: at.x + (previous.x - at.x) / incoming * radius, y: at.y + (previous.y - at.y) / incoming * radius }
    const after = { x: at.x + (next.x - at.x) / outgoing * radius, y: at.y + (next.y - at.y) / outgoing * radius }
    commands.push(`L ${before.x} ${before.y} Q ${at.x} ${at.y} ${after.x} ${after.y}`)
  }
  const last = points.at(-1)!; commands.push(`L ${last.x} ${last.y}`)
  return commands.join(' ')
}

/** Constant-size route from exact original endpoints. No global obstacle scan or WASM. */
export function routeCollaboration(boxes: ReadonlyMap<string, CollaborationBox>, connection: CollaborationConnection): CollaborationPath {
  const from = boxes.get(connection.source)!, to = boxes.get(connection.target)!, { kind } = connection
  const sameArea = from.areaId === to.areaId, direction = from.x === to.x ? from.y <= to.y ? 1 : -1 : from.x < to.x ? 1 : -1
  const lane = lanes[kind] + direction
  const sourceSide: CollaborationSide = sameArea ? from.cardColumn === 0 ? 'right' : 'left' : from.column === 0 ? 'right' : 'left'
  const targetSide: CollaborationSide = sameArea ? to.cardColumn === 0 ? 'right' : 'left' : to.column === 0 ? 'right' : 'left'
  let points: CollaborationPoint[]
  if (sameArea) {
    const source = collaborationPortPoint(from, kind, 'out', sourceSide), target = collaborationPortPoint(to, kind, 'in', targetSide)
    const x = collaborationInnerX(from) + lane
    points = [source, { x, y: source.y }, { x, y: target.y }, target]
  } else {
    const start = escape(from, kind, 'out', sourceSide, lane), end = escape(to, kind, 'in', targetSide, lane)
    points = [...start, { x: 608 + lane, y: end.at(-1)!.y }, ...[...end].reverse()]
  }
  points = points.filter((point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y)
  const xs = points.map(point => point.x), ys = points.map(point => point.y), middle = points[Math.floor(points.length / 2)]!
  return { path: rounded(points), labelX: middle.x, labelY: middle.y, points,
    sourceHandle: collaborationPort(kind, 'out', sourceSide), targetHandle: collaborationPort(kind, 'in', targetSide),
    bounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } }
}
