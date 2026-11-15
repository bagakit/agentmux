import { CALLOUT_ZOOM_RANGE, calloutBubble, constrainedEndpoint, normalizeRect, shapeBounds, type CalloutShape, type NormalizedRect, type ScreenshotPoint, type ScreenshotShape, type TextShape } from './drawing-model.js'

type Corner = 'nw' | 'ne' | 'se' | 'sw'
/** `zoom-*` are the corners of a callout bubble; they change its zoom, not its source. */
export type SelectionHandleId = Corner | `zoom-${Corner}` | 'from' | 'to'
export type SelectionHandle = { id: SelectionHandleId; point: ScreenshotPoint }

/** Geometry stays in original image pixels; callers choose a tolerance that
 * keeps hit targets and painted handles consistent with their view scale. */
export function selectionHandles(shape: ScreenshotShape): SelectionHandle[] {
  if (shape.kind === 'arrow') return [{ id: 'from', point: shape.from }, { id: 'to', point: shape.to }]
  if (shape.kind === 'callout') return [...corners(normalizeRect(shape.from, shape.to)),
    ...corners(calloutBubble(shape)).map(handle => ({ ...handle, id: `zoom-${handle.id}` as const }))]
  if (shape.kind !== 'rect' && shape.kind !== 'ellipse' && shape.kind !== 'note' && shape.kind !== 'pixelate' && shape.kind !== 'cover' && shape.kind !== 'blur' && shape.kind !== 'spotlight') return []
  // A wand outline follows the image's pixels; stretching it would no longer match them, so it only moves.
  if ('outline' in shape && shape.outline) return []
  return corners(normalizeRect(shape.from, shape.to))
}

function corners(rect: NormalizedRect): { id: Corner; point: ScreenshotPoint }[] {
  return [
    { id: 'nw', point: { x: rect.x, y: rect.y } },
    { id: 'ne', point: { x: rect.x + rect.width, y: rect.y } },
    { id: 'se', point: { x: rect.x + rect.width, y: rect.y + rect.height } },
    { id: 'sw', point: { x: rect.x, y: rect.y + rect.height } }
  ]
}

/** The opposite bubble corner stays fixed; the larger proportional reach sets the zoom. */
function resizeCalloutBubble(original: CalloutShape, corner: Corner, point: ScreenshotPoint): CalloutShape {
  const source = normalizeRect(original.from, original.to), bubble = calloutBubble(original)
  if (source.width <= 0 || source.height <= 0) return original
  const left = corner === 'nw' || corner === 'sw', top = corner === 'nw' || corner === 'ne'
  const fixed = { x: left ? bubble.x + bubble.width : bubble.x, y: top ? bubble.y + bubble.height : bubble.y }
  const reach = Math.max((left ? fixed.x - point.x : point.x - fixed.x) / source.width, (top ? fixed.y - point.y : point.y - fixed.y) / source.height)
  const zoom = Math.min(CALLOUT_ZOOM_RANGE.max, Math.max(CALLOUT_ZOOM_RANGE.min, reach))
  const width = source.width * zoom, height = source.height * zoom
  return { ...original, zoom, at: { x: left ? fixed.x - width : fixed.x, y: top ? fixed.y - height : fixed.y } }
}

export function hitSelectionHandle(shape: ScreenshotShape, point: ScreenshotPoint, tolerance: number): SelectionHandleId | null {
  let nearest: SelectionHandleId | null = null
  let distance = tolerance
  for (const handle of selectionHandles(shape)) {
    const next = Math.hypot(handle.point.x - point.x, handle.point.y - point.y)
    if (next <= tolerance && (nearest === null || next < distance)) {
      nearest = handle.id
      distance = next
    }
  }
  return nearest
}

/** Apply each drag sample to the gesture's original shape. Opposite coordinates
 * stay fixed across corner cross-over, and from/to retain their original roles
 * (notably the numbered note anchor) without changing IDs or style. */
export function resizeShapeFromHandle(original: ScreenshotShape, handle: SelectionHandleId, point: ScreenshotPoint, constrained = false): ScreenshotShape {
  if (original.kind === 'arrow') {
    if (constrained) point = constrainedEndpoint('arrow', handle === 'from' ? original.to : original.from, point)
    if (handle === 'from') return { ...original, from: { ...point } }
    if (handle === 'to') return { ...original, to: { ...point } }
    return original
  }
  if (original.kind === 'callout' && handle.startsWith('zoom-')) return resizeCalloutBubble(original, handle.slice(5) as Corner, point)
  if (original.kind !== 'rect' && original.kind !== 'ellipse' && original.kind !== 'note' && original.kind !== 'pixelate' && original.kind !== 'cover' && original.kind !== 'blur' && original.kind !== 'spotlight' && original.kind !== 'callout') return original
  if (handle === 'from' || handle === 'to' || handle.startsWith('zoom-') || ('outline' in original && original.outline)) return original
  const from = { ...original.from }, to = { ...original.to }
  const left = handle === 'nw' || handle === 'sw'
  const top = handle === 'nw' || handle === 'ne'
  if (constrained && (original.kind === 'rect' || original.kind === 'ellipse')) {
    const box = normalizeRect(original.from, original.to)
    point = constrainedEndpoint(original.kind, { x: box.x + (left ? box.width : 0), y: box.y + (top ? box.height : 0) }, point)
  }
  if (left === (original.from.x <= original.to.x)) from.x = point.x
  else to.x = point.x
  if (top === (original.from.y <= original.to.y)) from.y = point.y
  else to.y = point.y
  return { ...original, from, to }
}

/** Ids of unlocked marks whose bounds touch the marquee, in stacking order. Edges count,
 * so a straight horizontal arrow (zero-height bounds) is still caught. */
export function marqueeSelection(shapes: readonly ScreenshotShape[], marquee: NormalizedRect,
  textWidth?: (shape: TextShape) => number): string[] {
  return shapes.filter(shape => {
    if (shape.locked) return false
    const box = shapeBounds(shape, textWidth)
    return box.x <= marquee.x + marquee.width && box.x + box.width >= marquee.x && box.y <= marquee.y + marquee.height && box.y + box.height >= marquee.y
  }).map(shape => shape.id)
}

/** The topmost locked mark whose bounds, grown by `tolerance`, hold the point: the mark a
 * hovering pointer shows the lock of. Locked marks are never hit, so this is their only lookup. */
export function lockedMarkAt(shapes: readonly ScreenshotShape[], at: ScreenshotPoint, tolerance: number,
  textWidth?: (shape: TextShape) => number): ScreenshotShape | null {
  for (let index = shapes.length - 1; index >= 0; index--) {
    const shape = shapes[index]!
    if (!shape.locked) continue
    const box = shapeBounds(shape, textWidth)
    if (at.x >= box.x - tolerance && at.x <= box.x + box.width + tolerance && at.y >= box.y - tolerance && at.y <= box.y + box.height + tolerance) return shape
  }
  return null
}
