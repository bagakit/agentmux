import { normalizeRect, type ScreenshotPoint, type ScreenshotShape } from './drawing-model'

export type SelectionHandleId = 'nw' | 'ne' | 'se' | 'sw' | 'from' | 'to'
export type SelectionHandle = { id: SelectionHandleId; point: ScreenshotPoint }

/** Geometry stays in original image pixels; callers choose a tolerance that
 * keeps hit targets and painted handles consistent with their view scale. */
export function selectionHandles(shape: ScreenshotShape): SelectionHandle[] {
  if (shape.kind === 'arrow') return [{ id: 'from', point: shape.from }, { id: 'to', point: shape.to }]
  if (shape.kind !== 'rect' && shape.kind !== 'ellipse' && shape.kind !== 'note' && shape.kind !== 'pixelate' && shape.kind !== 'cover') return []
  const rect = normalizeRect(shape.from, shape.to)
  return [
    { id: 'nw', point: { x: rect.x, y: rect.y } },
    { id: 'ne', point: { x: rect.x + rect.width, y: rect.y } },
    { id: 'se', point: { x: rect.x + rect.width, y: rect.y + rect.height } },
    { id: 'sw', point: { x: rect.x, y: rect.y + rect.height } }
  ]
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
export function resizeShapeFromHandle(original: ScreenshotShape, handle: SelectionHandleId, point: ScreenshotPoint): ScreenshotShape {
  if (original.kind === 'arrow') {
    if (handle === 'from') return { ...original, from: { ...point } }
    if (handle === 'to') return { ...original, to: { ...point } }
    return original
  }
  if (original.kind !== 'rect' && original.kind !== 'ellipse' && original.kind !== 'note' && original.kind !== 'pixelate' && original.kind !== 'cover') return original
  if (handle === 'from' || handle === 'to') return original
  const from = { ...original.from }, to = { ...original.to }
  const left = handle === 'nw' || handle === 'sw'
  const top = handle === 'nw' || handle === 'ne'
  if (left === (original.from.x <= original.to.x)) from.x = point.x
  else to.x = point.x
  if (top === (original.from.y <= original.to.y)) from.y = point.y
  else to.y = point.y
  return { ...original, from, to }
}
