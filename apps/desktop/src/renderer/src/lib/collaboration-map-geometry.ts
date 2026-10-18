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

/** Small original point slots never expand into overlapping giant overview marks. */
export const collaborationOverviewScale = (box: CollaborationLayoutBounds, zoom: number) => Math.min(1 / zoom, Math.min(box.width, box.height) / 14)

/** Keep the original obstacle-safe route; connect its terminal stems to visible overview marks.
 * This is a cheap projection at the camera layer, never a new Worker route or relationship. */
export function collaborationOverviewPath(route: CollaborationPath, source: CollaborationLayoutBox, target: CollaborationLayoutBox, zoom: number) {
  const mark = (box: CollaborationLayoutBox, port: CollaborationLayoutPoint) => {
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const length = Math.hypot(port.x - center.x, port.y - center.y)
    const ratio = length ? Math.min(1, 6 * collaborationOverviewScale(box, zoom) / length) : 0
    return { x: center.x + (port.x - center.x) * ratio, y: center.y + (port.y - center.y) * ratio }
  }
  const points = [...route.points]
  if (source.kind === 'agent') {
    const start = points[0]!, visible = mark(source, start)
    points.unshift(visible, visible, start)
  }
  if (target.kind === 'agent') {
    const end = points.at(-1)!, visible = mark(target, end)
    points.push(end, visible, visible)
  }
  const path = [`M ${points[0]!.x} ${points[0]!.y}`]
  for (let index = 1; index < points.length; index += 3) path.push(`C ${points.slice(index, index + 3).map(point => `${point.x} ${point.y}`).join(' ')}`)
  return path.join(' ')
}
