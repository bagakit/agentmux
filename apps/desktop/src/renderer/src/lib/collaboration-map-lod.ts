import type { CollaborationLayoutBounds } from './collaboration-layout-engine'

export const COLLABORATION_DETAIL_START = .62
export const COLLABORATION_DETAIL_END = .82
export const COLLABORATION_OVERVIEW_MARK_SIZE = 28

const mix = (from: number, to: number, progress: number) => from + (to - from) * progress
const smooth = (from: number, to: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** Camera presentation is continuous and never changes the world's layout slots. */
export function collaborationMapLod(zoom: number) {
  return { identity: smooth(.32, .58, zoom), detail: smooth(COLLABORATION_DETAIL_START, COLLABORATION_DETAIL_END, zoom) }
}

/** Original small point slots cannot become giant overlapping overview marks. */
export const collaborationOverviewScale = (box: CollaborationLayoutBounds, zoom: number) =>
  Math.min(1 / zoom, Math.min(box.width, box.height) / (COLLABORATION_OVERVIEW_MARK_SIZE / 2))

export type CollaborationVisibleHull = CollaborationLayoutBounds & { radius: number }

/** One footprint owner for the rendered body, directed endpoints and label clearance.
 * The circle, compact identity and readable body share the original slot's center. */
export function collaborationVisibleHull(box: CollaborationLayoutBounds, zoom: number, overviewRadius = COLLABORATION_OVERVIEW_MARK_SIZE / 2, pointRadius = 6): CollaborationVisibleHull {
  const { identity, detail } = collaborationMapLod(zoom)
  const scale = collaborationOverviewScale(box, zoom)
  if (box.width <= 28 && box.height <= 28) {
    const radius = mix(overviewRadius, pointRadius, identity) * mix(scale, 1, identity)
    return { x: box.x + box.width / 2 - radius, y: box.y + box.height / 2 - radius, width: radius * 2, height: radius * 2, radius }
  }
  const diameter = overviewRadius * 2 * scale
  const compactWidth = Math.min(box.width, 154), compactHeight = Math.min(box.height, 38)
  const width = mix(mix(diameter, compactWidth, identity), box.width, detail)
  const height = mix(mix(diameter, compactHeight, identity), box.height, detail)
  const radius = Math.min(width / 2, height / 2, mix(mix(diameter / 2, 8, identity), 6, detail))
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height, radius }
}

export const collaborationVisibleHitBounds = (box: CollaborationLayoutBounds, zoom: number): CollaborationLayoutBounds => collaborationVisibleHull(box, zoom, 14, Math.min(box.width, box.height) / 2)

/** Explicit camera intent uses the same effective preference as original event marks. */
export const collaborationCameraDuration = (motion: boolean, initial = false) => motion && !initial ? 280 : 0
