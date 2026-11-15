// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

export type ScreenshotTool = 'pen' | 'highlight' | 'arrow' | 'rect' | 'ellipse' | 'text'
export type ScreenshotPoint = { x: number; y: number }

/** A locked mark is never hit, erased, marquee-selected or moved; it still paints and exports. */
type ShapeBase = { id: string; color: string; locked?: true }

export type PenShape = ShapeBase & { kind: 'pen'; points: ScreenshotPoint[]; width: number }
export type HighlightShape = ShapeBase & { kind: 'highlight'; points: ScreenshotPoint[]; width: number }
export type ArrowShape = ShapeBase & { kind: 'arrow'; from: ScreenshotPoint; to: ScreenshotPoint; width: number }
export type RectShape = ShapeBase & { kind: 'rect'; from: ScreenshotPoint; to: ScreenshotPoint; width: number }
export type EllipseShape = ShapeBase & { kind: 'ellipse'; from: ScreenshotPoint; to: ScreenshotPoint; width: number }
export type TextShape = ShapeBase & { kind: 'text'; at: ScreenshotPoint; text: string; fontSize: number }
export type NoteTemplate = 'observation' | 'expected' | 'request'
export type NoteShape = ShapeBase & { kind: 'note'; from: ScreenshotPoint; to: ScreenshotPoint; width: number; radius: number; number: number; note: string; template?: NoteTemplate }
/** Closed rings in original image pixels, filled even-odd, that narrow a region mark to a magic wand selection.
 * from/to stays their bounding rect, so bounds, hits and note filtering never cover less than the outline. */
export type ScreenshotOutline = ScreenshotPoint[][]
type Outlined = { outline?: ScreenshotOutline }
export type PixelateShape = ShapeBase & Outlined & { kind: 'pixelate'; from: ScreenshotPoint; to: ScreenshotPoint; blockSize: number }
export type PixelateBrushShape = ShapeBase & { kind: 'pixelate-brush'; points: ScreenshotPoint[]; width: number; blockSize: number }
export type CoverShape = ShapeBase & Outlined & { kind: 'cover'; from: ScreenshotPoint; to: ScreenshotPoint }
/** A translucent color mark over a selected region; it never redacts text or pixels. */
export type RegionHighlightShape = ShapeBase & Outlined & { kind: 'region-highlight'; from: ScreenshotPoint; to: ScreenshotPoint }
/** `radius` is the Gaussian blur radius in original image pixels. */
export type BlurShape = ShapeBase & Outlined & { kind: 'blur'; from: ScreenshotPoint; to: ScreenshotPoint; radius: number }
/** Darkens everything outside from/to by `dim` (0..1 opacity). It points, it does not redact. */
export type SpotlightShape = ShapeBase & Outlined & { kind: 'spotlight'; from: ScreenshotPoint; to: ScreenshotPoint; dim: number }
/** from/to is the source region; the bubble's top-left is `at` and its size is the source size × zoom. */
export type CalloutShape = ShapeBase & { kind: 'callout'; from: ScreenshotPoint; to: ScreenshotPoint; at: ScreenshotPoint; zoom: number }
/** Brightness, contrast and saturation are factors (1 leaves the image unchanged); sharpen is an unsharp amount.
 * from/to is the range (the whole image, or a wand selection's bounds with its outline). */
export type AdjustShape = ShapeBase & Outlined & { kind: 'adjust'; from: ScreenshotPoint; to: ScreenshotPoint
  brightness: number; contrast: number; saturation: number; sharpen: number }

export type ScreenshotShape = PenShape | HighlightShape | ArrowShape | RectShape | EllipseShape | TextShape | NoteShape | PixelateShape | PixelateBrushShape | CoverShape | RegionHighlightShape | BlurShape | SpotlightShape | CalloutShape | AdjustShape
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
export const ADJUST_FACTOR_RANGE = { min: 0.5, max: 1.5 } as const
export const ADJUST_SHARPEN_RANGE = { min: 0, max: 1 } as const
export type AdjustParameters = Pick<AdjustShape, 'brightness' | 'contrast' | 'saturation' | 'sharpen'>
export const NEUTRAL_ADJUSTMENT: Readonly<AdjustParameters> = { brightness: 1, contrast: 1, saturation: 1, sharpen: 0 }
/** An outline larger than this is refused, never truncated: a cut ring would redact less than the selection. */
export const OUTLINE_LIMITS = { rings: 10_000, points: 250_000 } as const

const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, value))
export function createBlurShape(id: string, color: string, from: ScreenshotPoint, to: ScreenshotPoint, radius = DEFAULT_BLUR_RADIUS): BlurShape {
  return { id, color, kind: 'blur', from, to, radius: clamp(radius, BLUR_RADIUS_RANGE) }
}
export function createSpotlightShape(id: string, color: string, from: ScreenshotPoint, to: ScreenshotPoint, dim = DEFAULT_SPOTLIGHT_DIM): SpotlightShape {
  return { id, color, kind: 'spotlight', from, to, dim: clamp(dim, SPOTLIGHT_DIM_RANGE) }
}
export function createAdjustShape(id: string, from: ScreenshotPoint, to: ScreenshotPoint, parameters: Partial<AdjustParameters> = {}): AdjustShape {
  const factor = (value: number) => clamp(value, ADJUST_FACTOR_RANGE)
  const merged = { ...NEUTRAL_ADJUSTMENT, ...parameters }
  return { id, color: '#ffffff', kind: 'adjust', from, to, brightness: factor(merged.brightness), contrast: factor(merged.contrast),
    saturation: factor(merged.saturation), sharpen: clamp(merged.sharpen, ADJUST_SHARPEN_RANGE) }
}

/** The outline's extreme corners, kept as the exact coordinates so moving or scaling them with the rings keeps them equal. */
export function outlineExtent(outline: readonly (readonly ScreenshotPoint[])[]): { from: ScreenshotPoint; to: ScreenshotPoint } | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const ring of outline) for (const point of ring) {
    left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y)
  }
  return right > left && bottom > top ? { from: { x: left, y: top }, to: { x: right, y: bottom } } : null
}

/** Whether every ring edge is horizontal or vertical, as a wand outline's always is, before and after a move or scale. */
export function isAxisAlignedOutline(outline: readonly (readonly ScreenshotPoint[])[]): boolean {
  return outline.every(ring => ring.every((point, index) => {
    const next = ring[(index + 1) % ring.length]!
    return point.x === next.x || point.y === next.y
  }))
}

/** The even-odd fill of an axis-aligned outline as rects, one per row band between edge ends and per filled span of it.
 * Their union is exactly the fill, so a renderer can snap each outward to whole canvas pixels. */
export function outlineRects(outline: readonly (readonly ScreenshotPoint[])[]): NormalizedRect[] {
  if (!isAxisAlignedOutline(outline)) throw new Error('A screenshot outline edge must be horizontal or vertical')
  const edges: { x: number; top: number; bottom: number }[] = []
  for (const ring of outline) ring.forEach((point, index) => {
    const next = ring[(index + 1) % ring.length]!
    if (point.x === next.x && point.y !== next.y) edges.push({ x: point.x, top: Math.min(point.y, next.y), bottom: Math.max(point.y, next.y) })
  })
  edges.sort((a, b) => a.top - b.top)
  const rows = [...new Set(edges.flatMap(edge => [edge.top, edge.bottom]))].sort((a, b) => a - b)
  const rects: NormalizedRect[] = []
  let active: typeof edges = [], next = 0
  for (let row = 0; row + 1 < rows.length; row++) {
    const top = rows[row]!, height = rows[row + 1]! - top
    while (next < edges.length && edges[next]!.top <= top) active.push(edges[next++]!)
    // Every edge end is a row boundary, so an edge still active past this row's top spans the whole row.
    active = active.filter(edge => edge.bottom > top)
    const xs = active.map(edge => edge.x).sort((a, b) => a - b)
    // Even-odd: a span between each odd crossing and the next is filled.
    for (let index = 0; index + 1 < xs.length; index += 2) if (xs[index + 1]! > xs[index]!) rects.push({ x: xs[index]!, y: top, width: xs[index + 1]! - xs[index]!, height })
  }
  return rects
}

/** Whether an outline has more rings or points than a document keeps; such a selection is refused whole. */
export function exceedsOutlineLimits(outline: readonly (readonly ScreenshotPoint[])[]): boolean {
  return outline.length > OUTLINE_LIMITS.rings || outline.reduce((total, ring) => total + ring.length, 0) > OUTLINE_LIMITS.points
}
/** Narrows a region mark to an outline; from/to become the outline's extent, the only rect bounds and filters use. */
export function withOutline<T extends ScreenshotShape & Outlined & { from: ScreenshotPoint; to: ScreenshotPoint }>(shape: T, outline: ScreenshotOutline): T {
  const extent = outlineExtent(outline)
  if (!extent) throw new Error('A screenshot outline needs an area')
  if (exceedsOutlineLimits(outline)) throw new Error('The selected region is too detailed to keep as an exact outline')
  if (!isAxisAlignedOutline(outline)) throw new Error('A screenshot outline edge must be horizontal or vertical')
  return { ...shape, outline, ...extent }
}

/** Screen points between a source and its default bubble. The editor passes `CALLOUT_GAP / view scale` as the gap, so it
 * reads the same at every zoom and pixel ratio; without a gap the model takes one image pixel per point. */
export const CALLOUT_GAP = 20
/** Where a default bubble may go: inside `bounds` (the image, or a capture's selection), `gap` image pixels from its source. */
export interface CalloutPlacement { bounds?: NormalizedRect; gap?: number }
/** Without `at`, the bubble goes beside the source within the placement bounds: right, else left, else below, else above,
 * and if none fits it is clamped inside so the export never crops it. */
export function createCalloutShape(id: string, color: string, from: ScreenshotPoint, to: ScreenshotPoint, zoom = DEFAULT_CALLOUT_ZOOM,
  at?: ScreenshotPoint, placement: CalloutPlacement = {}): CalloutShape {
  const source = normalizeRect(from, to), scale = clamp(zoom, CALLOUT_ZOOM_RANGE)
  return { id, color, kind: 'callout', from, to, zoom: scale, at: at ?? calloutPlacement(source, source.width * scale, source.height * scale, placement) }
}

function calloutPlacement(source: NormalizedRect, width: number, height: number, { bounds, gap = CALLOUT_GAP }: CalloutPlacement): ScreenshotPoint {
  const right = { x: source.x + source.width + gap, y: source.y }
  if (!bounds) return right
  const fits = (at: ScreenshotPoint) => at.x >= bounds.x && at.y >= bounds.y && at.x + width <= bounds.x + bounds.width && at.y + height <= bounds.y + bounds.height
  const centredX = source.x + source.width / 2 - width / 2
  const candidates = [right, { x: source.x - gap - width, y: source.y },
    { x: centredX, y: source.y + source.height + gap }, { x: centredX, y: source.y - gap - height }]
  const fitting = candidates.find(fits)
  if (fitting) return fitting
  const inside = (value: number, start: number, length: number, size: number) => Math.max(start, Math.min(start + length - size, value))
  const clamped = (at: ScreenshotPoint) => ({ x: inside(at.x, bounds.x, bounds.width, width), y: inside(at.y, bounds.y, bounds.height, height) })
  const span = (start: number, size: number, from: number, length: number) => Math.min(start + size, from + length) - Math.max(start, from)
  const clears = (at: ScreenshotPoint) => span(at.x, width, source.x, source.width) < 0 || span(at.y, height, source.y, source.height) < 0
  // A place that clears the source ranks before one touching it (no room for a leader), which ranks before any overlap.
  const cover = (at: ScreenshotPoint) => clears(at) ? -1 : span(at.x, width, source.x, source.width) * span(at.y, height, source.y, source.height)
  // Without a full fit, the first place whose width fits is kept and only moved vertically, so it stays beside or below the source.
  const sideways = (at: ScreenshotPoint) => at.x >= bounds.x && at.x + width <= bounds.x + bounds.width
  const kept = clamped(candidates.find(sideways) ?? right)
  if (clears(kept)) return kept
  // When that place would cover or touch the source, the clamped place covering least of it wins, ties in the same order.
  return candidates.map(clamped).reduce((best, next) => cover(next) < cover(best) ? next : best)
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

/** Removing a numbered note closes the gap; Undo restores the earlier numbers from history. */
export function removeShapes(doc: ScreenshotDocument, ids: ReadonlySet<string>): ScreenshotDocument {
  const shapes = doc.shapes.filter(shape => !ids.has(shape.id))
  return shapes.length === doc.shapes.length ? doc : setShapes(doc, renumberNotes(shapes))
}

/** Numbers notes 1..n in their current number order (ties by id) without moving
 * them in paint order; unchanged shapes keep their identity. */
export function renumberNotes(shapes: readonly ScreenshotShape[]): ScreenshotShape[] {
  const order = shapes.filter((shape): shape is NoteShape => shape.kind === 'note')
    .sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const numbers = new Map(order.map((note, index) => [note.id, index + 1]))
  return shapes.map(shape => shape.kind === 'note' && shape.number !== numbers.get(shape.id) ? { ...shape, number: numbers.get(shape.id)! } : shape)
}

/** The number for a new note. An original saved with gaps still never gets a duplicate. */
export function nextNoteNumber(shapes: readonly ScreenshotShape[]): number {
  const notes = shapes.filter(shape => shape.kind === 'note')
  return Math.max(notes.length, ...notes.map(note => note.number)) + 1
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

const mapOutline = (shape: Outlined, map: (point: ScreenshotPoint) => ScreenshotPoint) => shape.outline ? { outline: shape.outline.map(ring => ring.map(map)) } : {}

export function scaleShape(shape: ScreenshotShape, scale: number): ScreenshotShape {
  const outline = (outlined: Outlined) => mapOutline(outlined, point => scalePoint(point, scale))
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
      return { ...shape, ...outline(shape), blockSize: shape.blockSize * scale, from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
    case 'cover':
    case 'region-highlight':
    case 'spotlight':
    case 'adjust':
      return { ...shape, ...outline(shape), from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
    case 'blur':
      return { ...shape, ...outline(shape), radius: shape.radius * scale, from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
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
      return { ...shape, from: move(shape.from), to: move(shape.to) }
    case 'pixelate':
    case 'cover':
    case 'region-highlight':
    case 'blur':
    case 'spotlight':
    case 'adjust':
      return { ...shape, ...mapOutline(shape, move), from: move(shape.from), to: move(shape.to) }
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

/** Union of the marks' bounds; null for no marks. */
export function groupBounds(shapes: readonly ScreenshotShape[], textWidth?: (shape: TextShape) => number): NormalizedRect | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const shape of shapes) {
    const box = shapeBounds(shape, textWidth)
    left = Math.min(left, box.x); top = Math.min(top, box.y); right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height)
  }
  return shapes.length ? { x: left, y: top, width: right - left, height: bottom - top } : null
}

/** Moves each listed mark by its own delta. Unmoved marks keep their identity, and
 * when nothing moves the same array returns so no empty Undo step is recorded. */
function moveEach(shapes: ScreenshotShape[], deltas: ReadonlyMap<string, ScreenshotPoint>): ScreenshotShape[] {
  let changed = false
  const next = shapes.map(shape => {
    const delta = deltas.get(shape.id)
    if (!delta || (!delta.x && !delta.y)) return shape
    changed = true
    return moveShape(shape, delta.x, delta.y)
  })
  return changed ? next : shapes
}

export function moveShapes(shapes: ScreenshotShape[], ids: ReadonlySet<string>, dx: number, dy: number): ScreenshotShape[] {
  return moveEach(shapes, new Map(shapes.filter(shape => ids.has(shape.id)).map(shape => [shape.id, { x: dx, y: dy }])))
}

export type ShapeAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
/** Aligns each mark's bounds to the same edge or centre of the group's bounds. */
export function alignShapes(shapes: ScreenshotShape[], ids: ReadonlySet<string>, alignment: ShapeAlignment,
  textWidth?: (shape: TextShape) => number): ScreenshotShape[] {
  const members = shapes.filter(shape => ids.has(shape.id)), group = groupBounds(members, textWidth)
  if (!group || members.length < 2) return shapes
  const horizontal = alignment === 'left' || alignment === 'center' || alignment === 'right'
  const fraction = alignment === 'left' || alignment === 'top' ? 0 : alignment === 'right' || alignment === 'bottom' ? 1 : 0.5
  return moveEach(shapes, new Map(members.map(shape => {
    const box = shapeBounds(shape, textWidth)
    const offset = horizontal ? group.x + (group.width - box.width) * fraction - box.x : group.y + (group.height - box.height) * fraction - box.y
    return [shape.id, horizontal ? { x: offset, y: 0 } : { x: 0, y: offset }]
  })))
}

/** Three or more marks: the outermost two stay and the rest move so every gap between neighbours is equal. */
export function distributeShapes(shapes: ScreenshotShape[], ids: ReadonlySet<string>, axis: 'horizontal' | 'vertical',
  textWidth?: (shape: TextShape) => number): ScreenshotShape[] {
  const start = axis === 'horizontal' ? 'x' : 'y', size = axis === 'horizontal' ? 'width' : 'height'
  const members = shapes.filter(shape => ids.has(shape.id)).map(shape => ({ shape, box: shapeBounds(shape, textWidth) }))
    .sort((a, b) => a.box[start] - b.box[start])
  if (members.length < 3) return shapes
  const first = members[0]!.box, last = members.at(-1)!.box
  const gap = (last[start] + last[size] - first[start] - members.reduce((sum, member) => sum + member.box[size], 0)) / (members.length - 1)
  let cursor = first[start] + first[size] + gap
  const deltas = new Map<string, ScreenshotPoint>()
  for (const { shape, box } of members.slice(1, -1)) {
    const offset = cursor - box[start]
    deltas.set(shape.id, axis === 'horizontal' ? { x: offset, y: 0 } : { x: 0, y: offset })
    cursor += box[size] + gap
  }
  return moveEach(shapes, deltas)
}

export type ShapeOrder = 'forward' | 'backward' | 'front' | 'back'
/** Changes stacking within each paint layer only, so every step is visible and a
 * mask still never paints under a mark. A contiguous selection moves as a block. */
export function reorderShapes(shapes: ScreenshotShape[], ids: ReadonlySet<string>, order: ShapeOrder): ScreenshotShape[] {
  const next = [...shapes]
  for (const layer of new Set(shapes.map(screenshotOutputLayer))) {
    const slots = shapes.flatMap((shape, index) => screenshotOutputLayer(shape) === layer ? [index] : [])
    const run = slots.map(index => shapes[index]!)
    let reordered: ScreenshotShape[]
    if (order === 'front' || order === 'back') {
      const picked = run.filter(shape => ids.has(shape.id)), rest = run.filter(shape => !ids.has(shape.id))
      reordered = order === 'front' ? [...rest, ...picked] : [...picked, ...rest]
    } else {
      reordered = [...run]
      const step = order === 'forward' ? 1 : -1
      for (let index = step > 0 ? reordered.length - 2 : 1; index >= 0 && index < reordered.length; index -= step) {
        const neighbour = index + step
        if (ids.has(reordered[index]!.id) && !ids.has(reordered[neighbour]!.id)) [reordered[index], reordered[neighbour]] = [reordered[neighbour]!, reordered[index]!]
      }
    }
    slots.forEach((slot, index) => { next[slot] = reordered[index]! })
  }
  return next.every((shape, index) => shape === shapes[index]) ? shapes : next
}

/** Adds copies of `sources` on top, offset by `offset`, each with a fresh id; copied
 * notes take the next free numbers so no number repeats. */
export function pasteShapes(shapes: ScreenshotShape[], sources: readonly ScreenshotShape[], offset: ScreenshotPoint,
  mintId: () => string): { shapes: ScreenshotShape[]; ids: string[] } {
  let number = nextNoteNumber(shapes)
  const copies = sources.map(source => {
    const moved = { ...moveShape(source, offset.x, offset.y), id: mintId() }
    return moved.kind === 'note' ? { ...moved, number: number++ } : moved
  })
  return { shapes: copies.length ? [...shapes, ...copies] : shapes, ids: copies.map(copy => copy.id) }
}

export function duplicateShapes(shapes: ScreenshotShape[], ids: ReadonlySet<string>, offset: ScreenshotPoint,
  mintId: () => string): { shapes: ScreenshotShape[]; ids: string[] } {
  return pasteShapes(shapes, shapes.filter(shape => ids.has(shape.id)), offset, mintId)
}

/** Applies `update` to each listed mark; a mark it returns unchanged keeps its identity, and
 * when none changes the same array returns so no empty Undo step is recorded. */
export function restyleShapes(shapes: ScreenshotShape[], ids: ReadonlySet<string>,
  update: (shape: ScreenshotShape) => ScreenshotShape): ScreenshotShape[] {
  const next = shapes.map(shape => ids.has(shape.id) ? update(shape) : shape)
  return next.every((shape, index) => shape === shapes[index]) ? shapes : next
}

/** Locks or unlocks the listed marks; when none changes, the same array returns. */
export function setShapesLocked(shapes: ScreenshotShape[], ids: ReadonlySet<string>, locked: boolean): ScreenshotShape[] {
  return restyleShapes(shapes, ids, shape => Boolean(shape.locked) === locked ? shape : setLocked(shape, locked))
}

function setLocked(shape: ScreenshotShape, locked: boolean): ScreenshotShape {
  if (locked) return { ...shape, locked: true }
  const { locked: _locked, ...rest } = shape
  return rest as ScreenshotShape
}

export function intersectRect(a: NormalizedRect, b: NormalizedRect): NormalizedRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** Paint layers: adjustments of the image first, then marks, then masks, then pointing marks that only see processed
 * pixels. A spotlight paints last so it dims every other mark outside it. */
export function screenshotOutputLayer(shape: ScreenshotShape): number {
  if (shape.kind === 'adjust') return -1
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
    if (shape.locked) continue
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
    // An adjustment often spans the whole image; it is chosen from its property entry so it never takes a canvas press.
    if (shape.kind === 'adjust') continue
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
    if (shape.kind === 'text' || shape.kind === 'pixelate' || shape.kind === 'cover' || shape.kind === 'region-highlight' || shape.kind === 'blur') return shape
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
