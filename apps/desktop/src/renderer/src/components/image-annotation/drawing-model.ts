// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

export type ScreenshotTool = 'pen' | 'highlight' | 'arrow' | 'rect' | 'ellipse' | 'text'
export type ScreenshotPoint = { x: number; y: number }

type ShapeBase = { id: string; color: string }

export type PenShape = ShapeBase & { kind: 'pen'; points: ScreenshotPoint[]; width: number }
export type HighlightShape = ShapeBase & { kind: 'highlight'; points: ScreenshotPoint[]; width: number }
export type ArrowShape = ShapeBase & { kind: 'arrow'; from: ScreenshotPoint; to: ScreenshotPoint; width: number }
export type RectShape = ShapeBase & { kind: 'rect'; from: ScreenshotPoint; to: ScreenshotPoint; width: number }
export type EllipseShape = ShapeBase & { kind: 'ellipse'; from: ScreenshotPoint; to: ScreenshotPoint; width: number }
export type TextShape = ShapeBase & { kind: 'text'; at: ScreenshotPoint; text: string; fontSize: number }
export type NoteTemplate = 'observation' | 'expected' | 'request'
export type NoteShape = ShapeBase & { kind: 'note'; from: ScreenshotPoint; to: ScreenshotPoint; width: number; radius: number; number: number; note: string; template?: NoteTemplate }
export type PixelateShape = ShapeBase & { kind: 'pixelate'; from: ScreenshotPoint; to: ScreenshotPoint; blockSize: number }
export type PixelateBrushShape = ShapeBase & { kind: 'pixelate-brush'; points: ScreenshotPoint[]; width: number; blockSize: number }
export type CoverShape = ShapeBase & { kind: 'cover'; from: ScreenshotPoint; to: ScreenshotPoint }
/** `radius` is the Gaussian blur radius in original image pixels. */
export type BlurShape = ShapeBase & { kind: 'blur'; from: ScreenshotPoint; to: ScreenshotPoint; radius: number }
/** Darkens everything outside from/to by `dim` (0..1 opacity). It points, it does not redact. */
export type SpotlightShape = ShapeBase & { kind: 'spotlight'; from: ScreenshotPoint; to: ScreenshotPoint; dim: number }
/** from/to is the source region; the bubble's top-left is `at` and its size is the source size × zoom. */
export type CalloutShape = ShapeBase & { kind: 'callout'; from: ScreenshotPoint; to: ScreenshotPoint; at: ScreenshotPoint; zoom: number }

export type ScreenshotShape = PenShape | HighlightShape | ArrowShape | RectShape | EllipseShape | TextShape | NoteShape | PixelateShape | PixelateBrushShape | CoverShape | BlurShape | SpotlightShape | CalloutShape
export type ScreenshotMask = PixelateShape | PixelateBrushShape | CoverShape | BlurShape

export const SCREENSHOT_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#111827', '#ffffff'] as const
export const DEFAULT_SCREENSHOT_COLOR: string = SCREENSHOT_COLORS[0]
export const SCREENSHOT_WIDTHS = [2, 4, 8] as const
export const DEFAULT_SCREENSHOT_WIDTH = 4
export const SCREENSHOT_FONT_SIZES = [14, 18, 24, 32, 48] as const
export const DEFAULT_SCREENSHOT_FONT_SIZE = 18
export const HIGHLIGHT_ALPHA = 0.35
export const SCREENSHOT_TEXT_LINE_HEIGHT = 1.2
const HIGHLIGHT_WIDTH_MULTIPLIER = 4
export const BLUR_RADIUS_RANGE = { min: 2, max: 64 } as const
export const DEFAULT_BLUR_RADIUS = 12
export const SPOTLIGHT_DIM_RANGE = { min: 0.3, max: 0.85 } as const
export const DEFAULT_SPOTLIGHT_DIM = 0.6
export const CALLOUT_ZOOM_RANGE = { min: 1.5, max: 6 } as const
export const DEFAULT_CALLOUT_ZOOM = 2.5

const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, value))
export function createBlurShape(id: string, color: string, from: ScreenshotPoint, to: ScreenshotPoint, radius = DEFAULT_BLUR_RADIUS): BlurShape {
  return { id, color, kind: 'blur', from, to, radius: clamp(radius, BLUR_RADIUS_RANGE) }
}
export function createSpotlightShape(id: string, color: string, from: ScreenshotPoint, to: ScreenshotPoint, dim = DEFAULT_SPOTLIGHT_DIM): SpotlightShape {
  return { id, color, kind: 'spotlight', from, to, dim: clamp(dim, SPOTLIGHT_DIM_RANGE) }
}
/** Without `at`, the bubble starts to the right of the source with a small gap. */
export function createCalloutShape(id: string, color: string, from: ScreenshotPoint, to: ScreenshotPoint, zoom = DEFAULT_CALLOUT_ZOOM, at?: ScreenshotPoint): CalloutShape {
  const source = normalizeRect(from, to)
  return { id, color, kind: 'callout', from, to, zoom: clamp(zoom, CALLOUT_ZOOM_RANGE), at: at ?? { x: source.x + source.width + 16, y: source.y } }
}
export function calloutBubble(shape: CalloutShape): NormalizedRect {
  const source = normalizeRect(shape.from, shape.to)
  return { x: shape.at.x, y: shape.at.y, width: source.width * shape.zoom, height: source.height * shape.zoom }
}
/** The leader joins the closest pair of edge midpoints of the source and the bubble. */
export function calloutLeader(shape: CalloutShape): { from: ScreenshotPoint; to: ScreenshotPoint } {
  const midpoints = (rect: NormalizedRect) => [{ x: rect.x + rect.width / 2, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
    { x: rect.x + rect.width / 2, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height / 2 }]
  let best = { from: shape.from, to: shape.at }, distance = Infinity
  for (const from of midpoints(normalizeRect(shape.from, shape.to))) for (const to of midpoints(calloutBubble(shape))) {
    const next = Math.hypot(to.x - from.x, to.y - from.y)
    if (next < distance) { best = { from, to }; distance = next }
  }
  return best
}

export function screenshotTextLines(text: string): string[] { return text.split(/\r\n|\r|\n/) }
export function isScreenshotMask(shape: ScreenshotShape): shape is ScreenshotMask {
  return shape.kind === 'pixelate' || shape.kind === 'pixelate-brush' || shape.kind === 'cover' || shape.kind === 'blur'
}

/** Constraints affect original-image geometry, never the fitted viewport. */
export function constrainedEndpoint(kind: 'rect' | 'ellipse' | 'arrow', from: ScreenshotPoint, to: ScreenshotPoint): ScreenshotPoint {
  const dx = to.x - from.x, dy = to.y - from.y
  if (kind === 'arrow') {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, distance = Math.hypot(dx, dy)
    return { x: from.x + Math.cos(angle) * distance, y: from.y + Math.sin(angle) * distance }
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy))
  return { x: from.x + (dx < 0 ? -side : side), y: from.y + (dy < 0 ? -side : side) }
}

type ScreenshotSnapshot = {
  shapes: ScreenshotShape[]
  crop: NormalizedRect | null
}
export type ScreenshotDocument = ScreenshotSnapshot & { past: ScreenshotSnapshot[]; future: ScreenshotSnapshot[] }
const snapshot = (doc: ScreenshotDocument): ScreenshotSnapshot => ({ shapes: doc.shapes, crop: doc.crop })

export function createScreenshotDocument(): ScreenshotDocument {
  return { shapes: [], crop: null, past: [], future: [] }
}

export function setShapes(doc: ScreenshotDocument, shapes: ScreenshotShape[]): ScreenshotDocument {
  return { shapes, crop: doc.crop, past: [...doc.past, snapshot(doc)], future: [] }
}

export function setCrop(doc: ScreenshotDocument, crop: NormalizedRect | null): ScreenshotDocument {
  return { shapes: doc.shapes, crop, past: [...doc.past, snapshot(doc)], future: [] }
}

export function replaceShape(doc: ScreenshotDocument, shape: ScreenshotShape): ScreenshotDocument {
  return doc.shapes.some(item => item.id === shape.id)
    ? setShapes(doc, doc.shapes.map(item => item.id === shape.id ? shape : item)) : doc
}

export function removeShapes(doc: ScreenshotDocument, ids: ReadonlySet<string>): ScreenshotDocument {
  const shapes = doc.shapes.filter(shape => !ids.has(shape.id))
  return shapes.length === doc.shapes.length ? doc : setShapes(doc, shapes)
}

export function commitShape(doc: ScreenshotDocument, shape: ScreenshotShape): ScreenshotDocument {
  return setShapes(doc, [...doc.shapes, shape])
}

export function undoShape(doc: ScreenshotDocument): ScreenshotDocument {
  const previous = doc.past.at(-1)
  return previous
    ? { ...previous, past: doc.past.slice(0, -1), future: [snapshot(doc), ...doc.future] }
    : doc
}

export function redoShape(doc: ScreenshotDocument): ScreenshotDocument {
  const next = doc.future.at(0)
  return next
    ? { ...next, past: [...doc.past, snapshot(doc)], future: doc.future.slice(1) }
    : doc
}

export function clearShapes(doc: ScreenshotDocument): ScreenshotDocument {
  return doc.shapes.length === 0 && !doc.crop ? doc : { shapes: [], crop: null, past: [...doc.past, snapshot(doc)], future: [] }
}

export function canUndo(doc: ScreenshotDocument): boolean {
  return doc.past.length > 0
}

export function canRedo(doc: ScreenshotDocument): boolean {
  return doc.future.length > 0
}

export type NormalizedRect = { x: number; y: number; width: number; height: number }

export function normalizeRect(from: ScreenshotPoint, to: ScreenshotPoint): NormalizedRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y)
  }
}

function scalePoint(point: ScreenshotPoint, scale: number): ScreenshotPoint {
  return { x: point.x * scale, y: point.y * scale }
}

export function scaleShape(shape: ScreenshotShape, scale: number): ScreenshotShape {
  switch (shape.kind) {
    case 'pixelate-brush':
      return { ...shape, width: shape.width * scale, blockSize: shape.blockSize * scale, points: shape.points.map(point => scalePoint(point, scale)) }
    case 'pen':
    case 'highlight':
      return { ...shape, width: shape.width * scale, points: shape.points.map((point) => scalePoint(point, scale)) }
    case 'arrow':
    case 'rect':
    case 'ellipse':
      return { ...shape, width: shape.width * scale, from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
    case 'note':
      return { ...shape, width: shape.width * scale, radius: shape.radius * scale, from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
    case 'pixelate':
      return { ...shape, blockSize: shape.blockSize * scale, from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
    case 'cover':
    case 'spotlight':
      return { ...shape, from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
    case 'blur':
      return { ...shape, radius: shape.radius * scale, from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
    case 'text':
      return { ...shape, fontSize: shape.fontSize * scale, at: scalePoint(shape.at, scale) }
    case 'callout':
      return { ...shape, at: scalePoint(shape.at, scale), from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
  }
}

export function moveShape(shape: ScreenshotShape, dx: number, dy: number): ScreenshotShape {
  const move = (at: ScreenshotPoint) => ({ x: at.x + dx, y: at.y + dy })
  switch (shape.kind) {
    case 'pen':
    case 'highlight':
    case 'pixelate-brush':
      return { ...shape, points: shape.points.map(move) }
    case 'text':
      return { ...shape, at: move(shape.at) }
    case 'callout':
      return { ...shape, at: move(shape.at), from: move(shape.from), to: move(shape.to) }
    case 'arrow':
    case 'rect':
    case 'ellipse':
    case 'note':
    case 'pixelate':
    case 'cover':
    case 'blur':
    case 'spotlight':
      return { ...shape, from: move(shape.from), to: move(shape.to) }
  }
}

export function shapeBounds(shape: ScreenshotShape, textWidth?: (shape: TextShape) => number): NormalizedRect {
  if (shape.kind === 'text') {
    const lines = screenshotTextLines(shape.text)
    return { x: shape.at.x, y: shape.at.y, width: textWidth?.(shape) ?? lines.reduce((longest, line) => Math.max(longest, line.length), 0) * shape.fontSize * 0.65,
      height: shape.fontSize * SCREENSHOT_TEXT_LINE_HEIGHT * lines.length }
  }
  if (shape.kind === 'pen' || shape.kind === 'highlight' || shape.kind === 'pixelate-brush') {
    if (!shape.points.length) return { x: 0, y: 0, width: 0, height: 0 }
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
    for (const point of shape.points) { left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y) }
    const padding = (shape.kind === 'highlight' ? highlightWidth(shape.width) : shape.width) / 2
    return { x: left - padding, y: top - padding, width: right - left + padding * 2, height: bottom - top + padding * 2 }
  }
  const rect = normalizeRect(shape.from, shape.to)
  if (shape.kind === 'callout') {
    const bubble = calloutBubble(shape), x = Math.min(rect.x, bubble.x), y = Math.min(rect.y, bubble.y)
    return { x, y, width: Math.max(rect.x + rect.width, bubble.x + bubble.width) - x, height: Math.max(rect.y + rect.height, bubble.y + bubble.height) - y }
  }
  if (shape.kind === 'note') {
    const radius = shape.radius
    const x = Math.min(rect.x, shape.from.x - radius), y = Math.min(rect.y, shape.from.y - radius)
    return { x, y, width: Math.max(rect.x + rect.width, shape.from.x + radius) - x, height: Math.max(rect.y + rect.height, shape.from.y + radius) - y }
  }
  return rect
}

export function intersectRect(a: NormalizedRect, b: NormalizedRect): NormalizedRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** Paint layers: marks, then masks, then pointing marks that only see processed
 * pixels. A spotlight paints last so it dims every other mark outside it. */
export function screenshotOutputLayer(shape: ScreenshotShape): number {
  if (isScreenshotMask(shape)) return 1
  return shape.kind === 'callout' ? 2 : shape.kind === 'spotlight' ? 3 : 0
}

/** Both PNG and textual handoff consume this list. A cropped-away number or a
 * masked note must not survive solely as textual context. */
export function screenshotOutputShapes(shapes: readonly ScreenshotShape[], crop?: NormalizedRect | null): ScreenshotShape[] {
  const masks = shapes.filter(isScreenshotMask)
  const visible = shapes.filter(shape => {
    if (shape.kind !== 'note') return true
    if (crop && (shape.from.x < crop.x || shape.from.x >= crop.x + crop.width || shape.from.y < crop.y || shape.from.y >= crop.y + crop.height)) return false
    return !masks.some(mask => maskIntersectsRect(mask, shapeBounds(shape)))
  })
  return visible.map((shape, index) => ({ shape, index, layer: screenshotOutputLayer(shape) }))
    .sort((a, b) => a.layer - b.layer || a.index - b.index).map(item => item.shape)
}

/** A brush hides only its painted corridor, not everything in its bounding box. */
export function maskIntersectsRect(mask: ScreenshotMask, rect: NormalizedRect): boolean {
  if (mask.kind !== 'pixelate-brush') return intersectRect(rect, normalizeRect(mask.from, mask.to)) !== null
  const radius = mask.width / 2
  const pointDistance = (point: ScreenshotPoint) => Math.hypot(Math.max(rect.x - point.x, 0, point.x - rect.x - rect.width),
    Math.max(rect.y - point.y, 0, point.y - rect.y - rect.height))
  const corners = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height }, { x: rect.x + rect.width, y: rect.y + rect.height }]
  return mask.points.some((to, index) => {
    const from = mask.points[Math.max(0, index - 1)]!
    if (pointDistance(from) <= radius || pointDistance(to) <= radius) return true
    let near = 0, far = 1
    for (const [start, delta, min, max] of [[from.x, to.x - from.x, rect.x, rect.x + rect.width],
      [from.y, to.y - from.y, rect.y, rect.y + rect.height]] as const) {
      if (!delta) { if (start < min || start > max) far = -1; continue }
      const a = (min - start) / delta, b = (max - start) / delta
      near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b))
    }
    return near <= far || corners.some(corner => distanceToSegment(corner, from, to) <= radius)
  })
}

export function distanceToSegment(point: ScreenshotPoint, from: ScreenshotPoint, to: ScreenshotPoint): number {
  const dx = to.x - from.x, dy = to.y - from.y
  const t = dx || dy ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy)
}

function distanceToEllipse(point: ScreenshotPoint, rect: NormalizedRect): number {
  let rx = rect.width / 2, ry = rect.height / 2
  let x = Math.abs(point.x - rect.x - rx), y = Math.abs(point.y - rect.y - ry)
  if (!rx || !ry) return Infinity
  if (rx < ry) { [rx, ry] = [ry, rx]; [x, y] = [y, x] }
  if (rx === ry) return Math.abs(Math.hypot(x, y) - rx)
  const a = rx * rx, b = ry * ry
  if (y === 0) {
    if (x >= (a - b) / rx) return Math.abs(rx - x)
    const nearestX = a * x / (a - b)
    return Math.hypot(nearestX - x, ry * Math.sqrt(Math.max(0, 1 - nearestX * nearestX / a)))
  }
  // The closest ellipse point satisfies the Lagrange multiplier equation.
  // Bisection measures actual image pixels, including a very elongated ellipse.
  let low = -b, high = Math.max(rx * x + ry * y, a)
  for (let iteration = 0; iteration < 48; iteration++) {
    const t = (low + high) / 2
    const value = (rx * x / (t + a)) ** 2 + (ry * y / (t + b)) ** 2
    if (value > 1) low = t
    else high = t
  }
  const t = (low + high) / 2
  return Math.hypot(a * x / (t + a) - x, b * y / (t + b) - y)
}

/** Reverse paint order; line tools hit their ink, not empty bounding-box interiors. */
export function hitTestShape(shapes: readonly ScreenshotShape[], point: ScreenshotPoint, tolerance = 6,
  textWidth?: (shape: TextShape) => number): ScreenshotShape | null {
  for (let index = shapes.length - 1; index >= 0; index--) {
    const shape = shapes[index]!
    if (shape.kind === 'pen' || shape.kind === 'highlight' || shape.kind === 'pixelate-brush') {
      const reach = tolerance + (shape.kind === 'highlight' ? highlightWidth(shape.width) : shape.width) / 2
      if (shape.points.some((at, i) => distanceToSegment(point, shape.points[Math.max(0, i - 1)]!, at) <= reach)) return shape
      continue
    }
    if (shape.kind === 'arrow') {
      const head = arrowHeadGeometry(shape.from, shape.to, shape.width)
      if (distanceToSegment(point, shape.from, shape.to) <= tolerance + shape.width / 2 ||
        (head && Math.min(distanceToSegment(point, head.left, head.tip), distanceToSegment(point, head.tip, head.right)) <= tolerance + shape.width / 2)) return shape
      continue
    }
    if (shape.kind === 'spotlight') {
      // Its interior holds the marks it points at; only the frame selects it.
      if (nearRectEdge(point, normalizeRect(shape.from, shape.to), tolerance, tolerance + 1)) return shape
      continue
    }
    if (shape.kind === 'callout') {
      const bubble = calloutBubble(shape), leader = calloutLeader(shape)
      if (nearRectEdge(point, normalizeRect(shape.from, shape.to), tolerance, tolerance + 1) || distanceToSegment(point, leader.from, leader.to) <= tolerance + 1 ||
        (point.x >= bubble.x - tolerance && point.x <= bubble.x + bubble.width + tolerance && point.y >= bubble.y - tolerance && point.y <= bubble.y + bubble.height + tolerance)) return shape
      continue
    }
    if (shape.kind === 'note' && Math.hypot(point.x - shape.from.x, point.y - shape.from.y) <= shape.radius + tolerance) return shape
    const rect = shapeBounds(shape, textWidth)
    if (point.x < rect.x - tolerance || point.x > rect.x + rect.width + tolerance || point.y < rect.y - tolerance || point.y > rect.y + rect.height + tolerance) continue
    if (shape.kind === 'text' || shape.kind === 'pixelate' || shape.kind === 'cover' || shape.kind === 'blur') return shape
    const ink = tolerance + shape.width / 2
    if (shape.kind === 'ellipse') {
      if (distanceToEllipse(point, rect) <= ink) return shape
    } else if (nearRectEdge(point, normalizeRect(shape.from, shape.to), tolerance, ink)) return shape
  }
  return null
}

function nearRectEdge(point: ScreenshotPoint, box: NormalizedRect, tolerance: number, ink: number): boolean {
  if (point.x < box.x - tolerance || point.x > box.x + box.width + tolerance || point.y < box.y - tolerance || point.y > box.y + box.height + tolerance) return false
  return Math.min(Math.abs(point.x - box.x), Math.abs(point.x - box.x - box.width), Math.abs(point.y - box.y), Math.abs(point.y - box.y - box.height)) <= ink
}

export function highlightWidth(width: number): number {
  return width * HIGHLIGHT_WIDTH_MULTIPLIER
}

export function arrowHeadGeometry(from: ScreenshotPoint, to: ScreenshotPoint, width: number) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return null
  const angle = Math.atan2(dy, dx)
  const length = Math.max(10, width * 3.5)
  const headAngle = 0.45
  return {
    tip: to,
    left: {
      x: to.x + length * Math.cos(angle + Math.PI - headAngle),
      y: to.y + length * Math.sin(angle + Math.PI - headAngle)
    },
    right: {
      x: to.x + length * Math.cos(angle + Math.PI + headAngle),
      y: to.y + length * Math.sin(angle + Math.PI + headAngle)
    }
  }
}
