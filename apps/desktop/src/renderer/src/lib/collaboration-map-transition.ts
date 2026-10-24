import type { CollaborationLayoutBox, CollaborationLayoutPoint, CollaborationPath } from './collaboration-layout-engine'

export type CollaborationGeometryFrame = { boxes: ReadonlyMap<string, CollaborationLayoutBox>; paths: ReadonlyMap<string, CollaborationPath> }
export const COLLABORATION_LAYOUT_TRANSITION_MS = 220
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const point = (a: CollaborationLayoutPoint, b: CollaborationLayoutPoint, t: number) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) })
const bounds = (a: { x: number; y: number; width: number; height: number }, b: typeof a, t: number) =>
  ({ ...point(a, b, t), width: mix(a.width, b.width, t), height: mix(a.height, b.height, t) })

/** Subdivision preserves the exact cubic, including a different route's segment
 * count. Interpolation never drops its middle controls to invent a straight edge. */
function subdivide(points: readonly CollaborationLayoutPoint[], segments: number) {
  let output = [...points]
  while ((output.length - 1) / 3 < segments) {
    let at = 0, longest = -1
    for (let index = 0; index < output.length - 1; index += 3) {
      const length = [0, 1, 2].reduce((sum, step) => sum + Math.hypot(output[index + step + 1]!.x - output[index + step]!.x, output[index + step + 1]!.y - output[index + step]!.y), 0)
      if (length > longest) { longest = length; at = index }
    }
    const [a, b, c, d] = output.slice(at, at + 4) as [CollaborationLayoutPoint, CollaborationLayoutPoint, CollaborationLayoutPoint, CollaborationLayoutPoint]
    const ab = point(a, b, .5), bc = point(b, c, .5), cd = point(c, d, .5), abc = point(ab, bc, .5), bcd = point(bc, cd, .5)
    output.splice(at, 4, a, ab, abc, point(abc, bcd, .5), bcd, cd, d)
  }
  return output
}

/** Only this bounded presentation projection moves. Worker geometry and the
 * original structure snapshot remain authoritative inputs for later jobs. */
export function interpolateCollaborationGeometry(from: CollaborationGeometryFrame, to: CollaborationGeometryFrame, progress: number): CollaborationGeometryFrame {
  if (progress >= 1) return to
  const t = Math.max(0, progress), boxes = new Map<string, CollaborationLayoutBox>(), paths = new Map<string, CollaborationPath>()
  for (const [id, target] of to.boxes) {
    const old = from.boxes.get(id)
    // Fold visibility is atomic: a summary's actual port rectangle must not
    // become a transient giant body while its descendants are already hidden.
    if (!old || old.kind !== target.kind || old.folded !== target.folded || old === target) { boxes.set(id, target); continue }
    if (old.x === target.x && old.y === target.y && old.width === target.width && old.height === target.height &&
      (old.kind !== 'area' || target.kind === 'area' && old.heading.x === target.heading.x && old.heading.y === target.heading.y && old.heading.width === target.heading.width && old.heading.height === target.heading.height)) { boxes.set(id, target); continue }
    boxes.set(id, target.kind === 'area' && old.kind === 'area'
      ? { ...target, ...bounds(old, target, t), heading: bounds(old.heading, target.heading, t) }
      : { ...target, ...bounds(old, target, t) })
  }
  for (const [id, target] of to.paths) {
    const old = from.paths.get(id)
    if (!old || old === target || old.path === target.path && old.labelX === target.labelX && old.labelY === target.labelY) { paths.set(id, target); continue }
    const segments = Math.max((old.points.length - 1) / 3, (target.points.length - 1) / 3)
    const a = subdivide(old.points, segments), b = subdivide(target.points, segments), points = b.map((value, index) => point(a[index]!, value, t))
    const left = Math.min(...points.map(value => value.x)), top = Math.min(...points.map(value => value.y))
    paths.set(id, { ...target, points, path: `M ${points[0]!.x} ${points[0]!.y} ` + Array.from({ length: segments }, (_, segment) =>
      'C ' + points.slice(segment * 3 + 1, segment * 3 + 4).map(value => `${value.x} ${value.y}`).join(' ')).join(' '),
      labelX: mix(old.labelX, target.labelX, t), labelY: mix(old.labelY, target.labelY, t),
      bounds: { x: left, y: top, width: Math.max(...points.map(value => value.x)) - left, height: Math.max(...points.map(value => value.y)) - top } })
  }
  return { boxes, paths }
}
