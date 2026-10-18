import type { CollaborationLayoutBox, CollaborationLayoutBounds, CollaborationLayoutPoint, CollaborationPath } from './collaboration-layout-engine'

const cross = (a: CollaborationLayoutPoint, b: CollaborationLayoutPoint, c: CollaborationLayoutPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/** A presentation envelope of complete rectangles. It neither positions nor groups Agents. */
export function collaborationEnvelope(area: Extract<CollaborationLayoutBox, { kind: 'area' }>, members: readonly CollaborationLayoutBox[]) {
  const rectangles = [area.heading, ...members.map(box => ({ ...box, x: box.x - area.x, y: box.y - area.y }))]
  const points = rectangles.flatMap(({ x, y, width, height }, index) => {
    const pad = index === 0 ? 8 : 18
    return [{ x: x - pad, y: y - pad }, { x: x + width + pad, y: y - pad },
      { x: x + width + pad, y: y + height + pad }, { x: x - pad, y: y + height + pad }]
  }).sort((a, b) => a.x - b.x || a.y - b.y)
  const half = (values: readonly CollaborationLayoutPoint[]) => {
    const result: CollaborationLayoutPoint[] = []
    for (const point of values) {
      while (result.length > 1 && cross(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop()
      result.push(point)
    }
    return result.slice(0, -1)
  }
  const outline = [...half(points), ...half([...points].reverse())]
  const towards = (from: CollaborationLayoutPoint, to: CollaborationLayoutPoint, distance: number) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    const ratio = Math.min(distance / length, .25)
    return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio }
  }
  const corners = outline.map((point, index) => ({ point,
    start: towards(point, outline[(index + outline.length - 1) % outline.length]!, 16),
    end: towards(point, outline[(index + 1) % outline.length]!, 16) }))
  return `M ${corners[0]!.start.x} ${corners[0]!.start.y} ` + corners.map(({ point, start, end }) =>
    `L ${start.x} ${start.y} Q ${point.x} ${point.y} ${end.x} ${end.y}`).join(' ') + ' Z'
}

export const COLLABORATION_OVERVIEW_MARK_SIZE = 28
/** Small original point slots never expand into overlapping giant overview marks. */
export const collaborationOverviewScale = (box: CollaborationLayoutBounds, zoom: number) => Math.min(1 / zoom, Math.min(box.width, box.height) / (COLLABORATION_OVERVIEW_MARK_SIZE / 2))
export function collaborationOverviewHitBounds(box: CollaborationLayoutBounds, zoom: number): CollaborationLayoutBounds {
  const size = COLLABORATION_OVERVIEW_MARK_SIZE * collaborationOverviewScale(box, zoom)
  return { x: box.x + (box.width - size) / 2, y: box.y + (box.height - size) / 2, width: size, height: size }
}

/** Keep the original obstacle-safe route; connect its terminal stems to visible overview marks.
 * This is a cheap projection at the camera layer, never a new Worker route or relationship. */
export function collaborationOverviewPath(route: CollaborationPath, source: CollaborationLayoutBox, target: CollaborationLayoutBox, zoom: number, sourceRadius: number, targetRadius: number) {
  const split = (curve: readonly CollaborationLayoutPoint[], t: number) => {
    const mix = (a: CollaborationLayoutPoint, b: CollaborationLayoutPoint) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    const [a, b, c, d] = curve as [CollaborationLayoutPoint, CollaborationLayoutPoint, CollaborationLayoutPoint, CollaborationLayoutPoint]
    const ab = mix(a, b), bc = mix(b, c), cd = mix(c, d), abc = mix(ab, bc), bcd = mix(bc, cd), at = mix(abc, bcd)
    return [[a, ab, abc, at], [at, bcd, cd, d]] as const
  }
  const projectStart = (points: readonly CollaborationLayoutPoint[], box: CollaborationLayoutBox, radius: number): CollaborationLayoutPoint[] => {
    if (box.kind !== 'agent') return [...points]
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }, visibleRadius = radius * collaborationOverviewScale(box, zoom)
    const distance = (point: CollaborationLayoutPoint) => Math.hypot(point.x - center.x, point.y - center.y)
    const port = points[0]!, length = distance(port)
    if (length >= visibleRadius) {
      const ratio = length ? visibleRadius / length : 0
      const visible = { x: center.x + (port.x - center.x) * ratio, y: center.y + (port.y - center.y) * ratio }
      return [visible, visible, port, ...points]
    }
    // A short top/bottom port (and even its 8px stem) can lie inside the
    // overview avatar. Clip that hidden prefix along the original Bezier,
    // preserving its outgoing tangent and every later obstacle detour.
    const exit = (curve: readonly CollaborationLayoutPoint[], low = 0, high = 1, depth = 0): [number, number] | undefined => {
      if (curve.every(point => distance(point) <= visibleRadius)) return
      if (depth === 16) return distance(curve[3]!) > visibleRadius ? [low, high] : undefined
      const [left, right] = split(curve, .5), middle = (low + high) / 2
      return exit(left, low, middle, depth + 1) ?? exit(right, middle, high, depth + 1)
    }
    for (let index = 0; index < points.length - 1; index += 3) {
      const curve = points.slice(index, index + 4), bracket = exit(curve)
      if (!bracket) continue
      let [low, high] = bracket
      for (let iteration = 0; iteration < 24; iteration++) {
        const middle = (low + high) / 2
        if (distance(split(curve, middle)[1][0]!) <= visibleRadius) low = middle; else high = middle
      }
      return [...split(curve, (low + high) / 2)[1], ...points.slice(index + 4)]
    }
    // No part of this original curve leaves the visible endpoint body.
    return []
  }
  const from = projectStart(route.points, source, sourceRadius)
  if (!from.length) return ''
  const points = projectStart([...from].reverse(), target, targetRadius).reverse()
  if (!points.length) return ''
  const path = [`M ${points[0]!.x} ${points[0]!.y}`]
  for (let index = 1; index < points.length; index += 3) path.push(`C ${points.slice(index, index + 3).map(point => `${point.x} ${point.y}`).join(' ')}`)
  return path.join(' ')
}
