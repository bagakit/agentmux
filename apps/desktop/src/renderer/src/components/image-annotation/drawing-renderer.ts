// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import {
  arrowHeadGeometry,
  highlightWidth,
  normalizeRect,
  HIGHLIGHT_ALPHA,
  type ArrowShape,
  type EllipseShape,
  type HighlightShape,
  type PenShape,
  type RectShape,
  type NoteShape,
  type PixelateShape,
  type CoverShape,
  type ScreenshotShape,
  type TextShape
} from './drawing-model'

export const SCREENSHOT_TEXT_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'

export function drawScreenshotShape(context: CanvasRenderingContext2D, shape: ScreenshotShape): void {
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = shape.color
  context.fillStyle = shape.color
  try {
    switch (shape.kind) {
      case 'pen': drawStroke(context, shape); break
      case 'highlight': drawHighlight(context, shape); break
      case 'arrow': drawArrow(context, shape); break
      case 'rect': drawRect(context, shape); break
      case 'ellipse': drawEllipse(context, shape); break
      case 'text': drawText(context, shape); break
      case 'note': drawNote(context, shape); break
      case 'pixelate': drawPixelate(context, shape); break
      case 'cover': drawCover(context, shape); break
    }
  } finally { context.restore() }
}

export function drawScreenshotShapes(context: CanvasRenderingContext2D, shapes: readonly ScreenshotShape[]): void {
  for (const shape of shapes) drawScreenshotShape(context, shape)
}

function strokePolyline(
  context: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  width: number
): void {
  const first = points[0]
  if (!first) return
  if (points.length === 1) {
    context.beginPath()
    context.arc(first.x, first.y, Math.max(width / 2, 1), 0, Math.PI * 2)
    context.fill()
    return
  }
  context.beginPath()
  context.moveTo(first.x, first.y)
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!
    context.lineTo(point.x, point.y)
  }
  context.stroke()
}

function drawStroke(context: CanvasRenderingContext2D, shape: PenShape): void {
  context.lineWidth = shape.width
  strokePolyline(context, shape.points, shape.width)
}

function drawHighlight(context: CanvasRenderingContext2D, shape: HighlightShape): void {
  context.globalAlpha = HIGHLIGHT_ALPHA
  const width = highlightWidth(shape.width)
  context.lineWidth = width
  strokePolyline(context, shape.points, width)
}

function drawArrow(context: CanvasRenderingContext2D, shape: ArrowShape): void {
  context.lineWidth = shape.width
  context.beginPath()
  context.moveTo(shape.from.x, shape.from.y)
  context.lineTo(shape.to.x, shape.to.y)
  context.stroke()
  const head = arrowHeadGeometry(shape.from, shape.to, shape.width)
  if (!head) return
  context.beginPath()
  context.moveTo(head.left.x, head.left.y)
  context.lineTo(head.tip.x, head.tip.y)
  context.lineTo(head.right.x, head.right.y)
  context.stroke()
}

function drawRect(context: CanvasRenderingContext2D, shape: RectShape): void {
  context.lineWidth = shape.width
  const rect = normalizeRect(shape.from, shape.to)
  context.strokeRect(rect.x, rect.y, rect.width, rect.height)
}

function drawEllipse(context: CanvasRenderingContext2D, shape: EllipseShape): void {
  context.lineWidth = shape.width
  const rect = normalizeRect(shape.from, shape.to)
  context.beginPath()
  context.ellipse(
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    rect.width / 2,
    rect.height / 2,
    0,
    0,
    Math.PI * 2
  )
  context.stroke()
}

function drawText(context: CanvasRenderingContext2D, shape: TextShape): void {
  context.font = `600 ${shape.fontSize}px ${SCREENSHOT_TEXT_FONT}`
  context.textBaseline = 'top'
  context.lineWidth = Math.max(shape.fontSize / 6, 2)
  context.strokeStyle = shape.color.toLowerCase() === '#ffffff'
    ? 'rgba(0,0,0,0.65)'
    : 'rgba(255,255,255,0.85)'
  context.strokeText(shape.text, shape.at.x, shape.at.y)
  context.fillText(shape.text, shape.at.x, shape.at.y)
}

function drawNote(context: CanvasRenderingContext2D, shape: NoteShape): void {
  const box = normalizeRect(shape.from, shape.to)
  context.lineWidth = shape.width
  if (box.width > shape.radius && box.height > shape.radius) context.strokeRect(box.x, box.y, box.width, box.height)
  context.beginPath()
  context.arc(shape.from.x, shape.from.y, shape.radius, 0, Math.PI * 2)
  context.fill()
  context.strokeStyle = '#ffffff'
  context.lineWidth = Math.max(1, shape.radius / 8)
  context.stroke()
  context.fillStyle = shape.color.toLowerCase() === '#ffffff' ? '#111827' : '#ffffff'
  context.font = `700 ${shape.radius * 1.15}px ${SCREENSHOT_TEXT_FONT}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(String(shape.number), shape.from.x, shape.from.y)
}

/** Align outward to actual canvas pixels so fractional zoom/DPR cannot leave a
 * translucent edge. Cover always paints a fixed opaque color, including drafts
 * loaded with an alpha-bearing color field. The caller restores this transform. */
function drawCover(context: CanvasRenderingContext2D, shape: CoverShape): void {
  const rect = normalizeRect(shape.from, shape.to)
  if (rect.width <= 0 || rect.height <= 0) return
  const transform = context.getTransform()
  const left = Math.max(0, Math.floor(rect.x * transform.a + transform.e))
  const top = Math.max(0, Math.floor(rect.y * transform.d + transform.f))
  const right = Math.min(context.canvas.width, Math.ceil((rect.x + rect.width) * transform.a + transform.e))
  const bottom = Math.min(context.canvas.height, Math.ceil((rect.y + rect.height) * transform.d + transform.f))
  if (right <= left || bottom <= top) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalAlpha = 1
  context.globalCompositeOperation = 'source-over'
  context.fillStyle = '#111827'
  context.fillRect(left, top, right - left, bottom - top)
}

/** Sample the already painted image, then draw the blocks without interpolation.
 * The same renderer is used for preview and final PNG; no underlying pixels are exported. */
function drawPixelate(context: CanvasRenderingContext2D, shape: PixelateShape): void {
  const rect = normalizeRect(shape.from, shape.to)
  if (rect.width <= 0 || rect.height <= 0) return
  const transform = context.getTransform()
  const x = Math.max(0, Math.floor(rect.x * transform.a + transform.e))
  const y = Math.max(0, Math.floor(rect.y * transform.d + transform.f))
  const right = Math.min(context.canvas.width, Math.ceil((rect.x + rect.width) * transform.a + transform.e))
  const bottom = Math.min(context.canvas.height, Math.ceil((rect.y + rect.height) * transform.d + transform.f))
  if (right <= x || bottom <= y) return
  const sample = document.createElement('canvas')
  sample.width = Math.max(1, Math.ceil((right - x) / Math.max(1, shape.blockSize * transform.a)))
  sample.height = Math.max(1, Math.ceil((bottom - y) / Math.max(1, shape.blockSize * transform.d)))
  const small = sample.getContext('2d')
  if (!small) throw new Error('Screenshot pixelation requires a 2D canvas')
  small.drawImage(context.canvas, x, y, right - x, bottom - y, 0, 0, sample.width, sample.height)
  context.imageSmoothingEnabled = false
  context.drawImage(sample, 0, 0, sample.width, sample.height,
    (x - transform.e) / transform.a, (y - transform.f) / transform.d, (right - x) / transform.a, (bottom - y) / transform.d)
}
