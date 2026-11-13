// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import {
  arrowHeadGeometry,
  calloutBubble,
  calloutLeader,
  highlightWidth,
  normalizeRect,
  HIGHLIGHT_ALPHA,
  SCREENSHOT_TEXT_LINE_HEIGHT,
  screenshotTextLines,
  shapeBounds,
  type ArrowShape,
  type EllipseShape,
  type HighlightShape,
  type PenShape,
  type RectShape,
  type NoteShape,
  type PixelateShape,
  type PixelateBrushShape,
  type CoverShape,
  type BlurShape,
  type SpotlightShape,
  type CalloutShape,
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
      case 'pixelate-brush': {
        clipPixelateBrush(context, shape)
        const rect = shapeBounds(shape)
        drawPixelate(context, { ...shape, kind: 'pixelate', from: { x: rect.x, y: rect.y }, to: { x: rect.x + rect.width, y: rect.y + rect.height } })
        break
      }
      case 'cover': drawCover(context, shape); break
      case 'blur': drawBlur(context, shape); break
      case 'spotlight': drawSpotlight(context, shape); break
      case 'callout': drawCallout(context, shape); break
      default: { const unhandled: never = shape; throw new Error('Unsupported screenshot mark: ' + (unhandled as ScreenshotShape).kind) }
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
  screenshotTextLines(shape.text).forEach((line, index) => {
    const y = shape.at.y + index * shape.fontSize * SCREENSHOT_TEXT_LINE_HEIGHT
    context.strokeText(line, shape.at.x, y)
    context.fillText(line, shape.at.x, y)
  })
}

/** The same corridor clips final pixels and restores committed preview masks. */
export function clipPixelateBrush(context: CanvasRenderingContext2D, shape: PixelateBrushShape): void {
  const radius = shape.width / 2
  context.beginPath()
  shape.points.forEach((point, index) => {
    context.moveTo(point.x + radius, point.y); context.arc(point.x, point.y, radius, 0, Math.PI * 2)
    if (!index) return
    const previous = shape.points[index - 1]!, dx = point.x - previous.x, dy = point.y - previous.y, length = Math.hypot(dx, dy)
    if (!length) return
    const x = -dy / length * radius, y = dx / length * radius
    context.moveTo(previous.x + x, previous.y + y); context.lineTo(previous.x - x, previous.y - y)
    context.lineTo(point.x - x, point.y - y); context.lineTo(point.x + x, point.y + y); context.closePath()
  })
  context.clip()
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
  const sample = context.canvas.ownerDocument.createElement('canvas')
  sample.width = Math.max(1, Math.ceil((right - x) / Math.max(1, shape.blockSize * transform.a)))
  sample.height = Math.max(1, Math.ceil((bottom - y) / Math.max(1, shape.blockSize * transform.d)))
  const small = sample.getContext('2d')
  if (!small) throw new Error('Screenshot pixelation requires a 2D canvas')
  small.drawImage(context.canvas, x, y, right - x, bottom - y, 0, 0, sample.width, sample.height)
  context.imageSmoothingEnabled = false
  context.drawImage(sample, 0, 0, sample.width, sample.height,
    (x - transform.e) / transform.a, (y - transform.f) / transform.d, (right - x) / transform.a, (bottom - y) / transform.d)
}

/** Blur the already painted pixels inside the region, like pixelation. The
 * sample is padded with real neighbours, and stretched pixels where the canvas
 * ends, so the blurred edge stays opaque and never fades into the original. */
function drawBlur(context: CanvasRenderingContext2D, shape: BlurShape): void {
  const rect = normalizeRect(shape.from, shape.to)
  if (rect.width <= 0 || rect.height <= 0) return
  const transform = context.getTransform(), canvas = context.canvas
  const left = Math.max(0, Math.floor(rect.x * transform.a + transform.e))
  const top = Math.max(0, Math.floor(rect.y * transform.d + transform.f))
  const right = Math.min(canvas.width, Math.ceil((rect.x + rect.width) * transform.a + transform.e))
  const bottom = Math.min(canvas.height, Math.ceil((rect.y + rect.height) * transform.d + transform.f))
  if (right <= left || bottom <= top) return
  // An unsupported filter would silently repaint the sharp pixels.
  if (typeof context.filter !== 'string') throw new Error('Screenshot blur requires canvas filters')
  // The filter reaches about three radii; four keep every clipped pixel opaque.
  const radius = Math.max(1, shape.radius * transform.a), pad = Math.ceil(radius * 4)
  const sampleLeft = Math.max(0, left - pad), sampleTop = Math.max(0, top - pad)
  const sampleWidth = Math.min(canvas.width, right + pad) - sampleLeft, sampleHeight = Math.min(canvas.height, bottom + pad) - sampleTop
  const sample = canvas.ownerDocument.createElement('canvas')
  sample.width = right - left + pad * 2
  sample.height = bottom - top + pad * 2
  const padded = sample.getContext('2d')
  if (!padded) throw new Error('Screenshot blur requires a 2D canvas')
  padded.drawImage(canvas, sampleLeft, sampleTop, sampleWidth, sampleHeight, 0, 0, sample.width, sample.height)
  padded.drawImage(canvas, sampleLeft, sampleTop, sampleWidth, sampleHeight, sampleLeft - left + pad, sampleTop - top + pad, sampleWidth, sampleHeight)
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.beginPath(); context.rect(left, top, right - left, bottom - top); context.clip()
  // Replace, never overlay: a translucent source must not keep its sharp pixels.
  context.clearRect(left, top, right - left, bottom - top)
  context.globalAlpha = 1
  context.globalCompositeOperation = 'source-over'
  context.filter = `blur(${radius}px)`
  context.drawImage(sample, left - pad, top - pad)
}

/** Dim the whole canvas except the region; the even-odd hole keeps it untouched. */
function drawSpotlight(context: CanvasRenderingContext2D, shape: SpotlightShape): void {
  const rect = normalizeRect(shape.from, shape.to), inverse = context.getTransform().inverse()
  const corner = (x: number, y: number) => inverse.transformPoint({ x, y })
  const start = corner(0, 0), end = corner(context.canvas.width, context.canvas.height)
  context.beginPath()
  context.rect(start.x, start.y, end.x - start.x, end.y - start.y)
  context.rect(rect.x, rect.y, rect.width, rect.height)
  context.fillStyle = `rgba(0,0,0,${shape.dim})`
  context.fill('evenodd')
  if (rect.width <= 0 || rect.height <= 0) return
  context.strokeStyle = 'rgba(255,255,255,0.6)'
  context.lineWidth = 1 / Math.hypot(context.getTransform().a, context.getTransform().b)
  context.strokeRect(rect.x, rect.y, rect.width, rect.height)
}


/** The bubble enlarges what is already painted, so it shows processed mask
 * pixels and never the original under a mask. */
function drawCallout(context: CanvasRenderingContext2D, shape: CalloutShape): void {
  const source = normalizeRect(shape.from, shape.to), bubble = calloutBubble(shape), leader = calloutLeader(shape)
  if (source.width <= 0 || source.height <= 0) return
  const transform = context.getTransform(), canvas = context.canvas
  const left = Math.max(0, Math.floor(source.x * transform.a + transform.e))
  const top = Math.max(0, Math.floor(source.y * transform.d + transform.f))
  const right = Math.min(canvas.width, Math.ceil((source.x + source.width) * transform.a + transform.e))
  const bottom = Math.min(canvas.height, Math.ceil((source.y + source.height) * transform.d + transform.f))
  let sample: HTMLCanvasElement | null = null
  if (right > left && bottom > top) {
    sample = canvas.ownerDocument.createElement('canvas')
    sample.width = right - left; sample.height = bottom - top
    const copy = sample.getContext('2d')
    if (!copy) throw new Error('Screenshot callout requires a 2D canvas')
    copy.drawImage(canvas, left, top, sample.width, sample.height, 0, 0, sample.width, sample.height)
  }
  context.lineWidth = 2 / Math.hypot(transform.a, transform.b)
  context.beginPath(); context.moveTo(leader.from.x, leader.from.y); context.lineTo(leader.to.x, leader.to.y); context.stroke()
  context.strokeRect(source.x, source.y, source.width, source.height)
  const radius = Math.min(10 / Math.hypot(transform.a, transform.b), bubble.width / 2, bubble.height / 2)
  context.save()
  context.shadowColor = 'rgba(0,0,0,0.35)'
  context.shadowBlur = 12
  context.shadowOffsetY = 3
  context.beginPath(); context.roundRect(bubble.x, bubble.y, bubble.width, bubble.height, radius); context.fill()
  context.restore()
  context.save()
  context.beginPath(); context.roundRect(bubble.x, bubble.y, bubble.width, bubble.height, radius); context.clip()
  if (sample) {
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    const scaleX = bubble.width / source.width, scaleY = bubble.height / source.height
    context.drawImage(sample, 0, 0, sample.width, sample.height,
      bubble.x + ((left - transform.e) / transform.a - source.x) * scaleX, bubble.y + ((top - transform.f) / transform.d - source.y) * scaleY,
      sample.width / transform.a * scaleX, sample.height / transform.d * scaleY)
  }
  context.restore()
  context.beginPath(); context.roundRect(bubble.x, bubble.y, bubble.width, bubble.height, radius); context.stroke()
}
