// Portions adapted from Orca commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e.
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

export type ScreenshotShape = PenShape | HighlightShape | ArrowShape | RectShape | EllipseShape | TextShape

export const SCREENSHOT_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#111827', '#ffffff'] as const
export const DEFAULT_SCREENSHOT_COLOR: string = SCREENSHOT_COLORS[0]
export const SCREENSHOT_WIDTHS = [2, 4, 8] as const
export const DEFAULT_SCREENSHOT_WIDTH = 4
export const SCREENSHOT_FONT_SIZES = [14, 18, 24, 32, 48] as const
export const DEFAULT_SCREENSHOT_FONT_SIZE = 18
export const HIGHLIGHT_ALPHA = 0.35
const HIGHLIGHT_WIDTH_MULTIPLIER = 4

export type ScreenshotDocument = {
  shapes: ScreenshotShape[]
  past: ScreenshotShape[][]
  future: ScreenshotShape[][]
}

export function createScreenshotDocument(): ScreenshotDocument {
  return { shapes: [], past: [], future: [] }
}

export function setShapes(doc: ScreenshotDocument, shapes: ScreenshotShape[]): ScreenshotDocument {
  return { shapes, past: [...doc.past, doc.shapes], future: [] }
}

export function commitShape(doc: ScreenshotDocument, shape: ScreenshotShape): ScreenshotDocument {
  return setShapes(doc, [...doc.shapes, shape])
}

export function undoShape(doc: ScreenshotDocument): ScreenshotDocument {
  const previous = doc.past.at(-1)
  return previous
    ? { shapes: previous, past: doc.past.slice(0, -1), future: [doc.shapes, ...doc.future] }
    : doc
}

export function redoShape(doc: ScreenshotDocument): ScreenshotDocument {
  const next = doc.future.at(0)
  return next
    ? { shapes: next, past: [...doc.past, doc.shapes], future: doc.future.slice(1) }
    : doc
}

export function clearShapes(doc: ScreenshotDocument): ScreenshotDocument {
  return doc.shapes.length === 0 ? doc : setShapes(doc, [])
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
    case 'pen':
    case 'highlight':
      return { ...shape, width: shape.width * scale, points: shape.points.map((point) => scalePoint(point, scale)) }
    case 'arrow':
    case 'rect':
    case 'ellipse':
      return { ...shape, width: shape.width * scale, from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) }
    case 'text':
      return { ...shape, fontSize: shape.fontSize * scale, at: scalePoint(shape.at, scale) }
  }
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
