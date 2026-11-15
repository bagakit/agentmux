// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import {
  arrowHeadGeometry,
  calloutBubble,
  calloutLeader,
  highlightWidth,
  normalizeRect,
  outlineRects,
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
  type AdjustShape,
  type ScreenshotOutline,
  type ScreenshotShape,
  type TextShape
} from './drawing-model.js'

export const SCREENSHOT_TEXT_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'

export function drawScreenshotShape(context: CanvasRenderingContext2D, shape: ScreenshotShape): void {
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = shape.color
  context.fillStyle = shape.color
  try {
    clipMarkArea(context, shape)
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
        const rect = shapeBounds(shape)
        drawPixelate(context, { ...shape, kind: 'pixelate', from: { x: rect.x, y: rect.y }, to: { x: rect.x + rect.width, y: rect.y + rect.height } })
        break
      }
      case 'cover': drawCover(context, shape); break
      case 'region-highlight': {
        context.globalAlpha = HIGHLIGHT_ALPHA
        const rect = normalizeRect(shape.from, shape.to)
        context.fillRect(rect.x, rect.y, rect.width, rect.height)
        break
      }
      case 'blur': drawBlur(context, shape); break
      case 'spotlight': drawSpotlight(context, shape); break
      case 'callout': drawCallout(context, shape); break
      case 'adjust': drawAdjust(context, shape); break
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

/** Limits a mark to the pixels it changes inside its rect: a brush's corridor, or a wand outline's fill. The final paint
 * and the preview's protection of committed masks share this one rule. A spotlight's outline is its lit hole instead. */
export function clipMarkArea(context: CanvasRenderingContext2D, shape: ScreenshotShape): void {
  if (shape.kind === 'pixelate-brush') clipPixelateBrush(context, shape)
  else if ('outline' in shape && shape.outline && shape.kind !== 'spotlight') clipOutline(context, shape.outline)
}

function clipPixelateBrush(context: CanvasRenderingContext2D, shape: PixelateBrushShape): void {
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

/** The even-odd path of an outline's rings; points sit on image pixel corners. */
function outlinePath(context: CanvasRenderingContext2D, outline: ScreenshotOutline): void {
  for (const ring of outline) {
    ring.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y))
    context.closePath()
  }
}

/** A selection's two-tone dashed boundary, readable on light and dark pixels. `unit` is one screen pixel in image
 * pixels; `phase` shifts the dashes along the boundary in screen pixels, so stepping it marches them. */
export function drawMarchingAnts(context: CanvasRenderingContext2D, outline: ScreenshotOutline, unit: number, phase: number): void {
  context.save()
  // Fine contours at fit scale can cover the text they surround. Keep the exact
  // selection geometry for output while letting the underlying pixels read through.
  context.globalAlpha = unit > 1 ? 0.35 : 0.7
  context.beginPath(); outlinePath(context, outline)
  context.lineWidth = unit; context.setLineDash([4 * unit, 4 * unit])
  context.strokeStyle = '#000000'; context.lineDashOffset = -phase * unit; context.stroke()
  context.strokeStyle = '#ffffff'; context.lineDashOffset = (4 - phase) * unit; context.stroke()
  context.restore()
}

/** Clips to an outline's even-odd fill, holding every canvas pixel the fill touches whole. Like cover and pixelation the
 * transform is an axis-aligned scale and offset; each rect of the fill is aligned outward to canvas pixels, because an
 * antialiased path clip would leave a translucent rim of original pixels along the outline under a mask. */
function clipOutline(context: CanvasRenderingContext2D, outline: ScreenshotOutline): void {
  const transform = context.getTransform(), { a, d, e, f } = transform
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.beginPath()
  for (const rect of outlineRects(outline)) {
    const left = Math.floor(rect.x * a + e), top = Math.floor(rect.y * d + f)
    context.rect(left, top, Math.ceil((rect.x + rect.width) * a + e) - left, Math.ceil((rect.y + rect.height) * d + f) - top)
  }
  context.clip()
  context.setTransform(transform)
}

/** Dim the whole canvas except the region or its outline; the even-odd hole keeps it untouched. */
function drawSpotlight(context: CanvasRenderingContext2D, shape: SpotlightShape): void {
  // Like cover and pixelation, the canvas transform is an axis-aligned scale and offset.
  const rect = normalizeRect(shape.from, shape.to), transform = context.getTransform()
  context.beginPath()
  context.rect(-transform.e / transform.a, -transform.f / transform.d, context.canvas.width / transform.a, context.canvas.height / transform.d)
  if (shape.outline) outlinePath(context, shape.outline); else context.rect(rect.x, rect.y, rect.width, rect.height)
  context.fillStyle = `rgba(0,0,0,${shape.dim})`
  context.fill('evenodd')
  if (rect.width <= 0 || rect.height <= 0) return
  context.strokeStyle = 'rgba(255,255,255,0.6)'
  context.lineWidth = 1 / transform.a
  if (shape.outline) { context.beginPath(); outlinePath(context, shape.outline); context.stroke() }
  else context.strokeRect(rect.x, rect.y, rect.width, rect.height)
}

/** The canvas filter for an adjustment's factors, or none when they leave the image unchanged. */
function adjustFilter(shape: Pick<AdjustShape, 'brightness' | 'contrast' | 'saturation'>): string | null {
  return shape.brightness === 1 && shape.contrast === 1 && shape.saturation === 1 ? null
    : `brightness(${shape.brightness}) contrast(${shape.contrast}) saturate(${shape.saturation})`
}

/** Re-paint the already painted range through the factor filter, then sharpen it with one 3 × 3 unsharp step
 * computed only inside the range. Like blur it replaces the range and fails closed without canvas filters. */
function drawAdjust(context: CanvasRenderingContext2D, shape: AdjustShape): void {
  const filter = adjustFilter(shape)
  if (!filter && shape.sharpen <= 0) return
  const rect = normalizeRect(shape.from, shape.to)
  if (rect.width <= 0 || rect.height <= 0) return
  const transform = context.getTransform(), canvas = context.canvas
  const left = Math.max(0, Math.floor(rect.x * transform.a + transform.e))
  const top = Math.max(0, Math.floor(rect.y * transform.d + transform.f))
  const right = Math.min(canvas.width, Math.ceil((rect.x + rect.width) * transform.a + transform.e))
  const bottom = Math.min(canvas.height, Math.ceil((rect.y + rect.height) * transform.d + transform.f))
  if (right <= left || bottom <= top) return
  // A one-pixel margin of real neighbours keeps the sharpened edge consistent with the pixels beside the range.
  const sampleLeft = Math.max(0, left - 1), sampleTop = Math.max(0, top - 1)
  const sampleRight = Math.min(canvas.width, right + 1), sampleBottom = Math.min(canvas.height, bottom + 1)
  const sample = canvas.ownerDocument.createElement('canvas')
  sample.width = sampleRight - sampleLeft; sample.height = sampleBottom - sampleTop
  const target = sample.getContext('2d')
  if (!target) throw new Error('Screenshot adjustment requires a 2D canvas')
  if (filter) {
    if (typeof target.filter !== 'string') throw new Error('Screenshot adjustment requires canvas filters')
    target.filter = filter
  }
  target.drawImage(canvas, sampleLeft, sampleTop, sample.width, sample.height, 0, 0, sample.width, sample.height)
  target.filter = 'none'
  if (shape.sharpen > 0) {
    const pixels = target.getImageData(0, 0, sample.width, sample.height), source = pixels.data.slice(), width = sample.width, height = sample.height
    const amount = shape.sharpen
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4, up = (Math.max(0, y - 1) * width + x) * 4, down = (Math.min(height - 1, y + 1) * width + x) * 4
      const before = (y * width + Math.max(0, x - 1)) * 4, after = (y * width + Math.min(width - 1, x + 1)) * 4
      for (let channel = 0; channel < 3; channel++) {
        const centre = source[at + channel]!
        pixels.data[at + channel] = centre + amount * (4 * centre - source[up + channel]! - source[down + channel]! - source[before + channel]! - source[after + channel]!)
      }
    }
    target.putImageData(pixels, 0, 0)
  }
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.beginPath(); context.rect(left, top, right - left, bottom - top); context.clip()
  context.clearRect(left, top, right - left, bottom - top)
  context.globalAlpha = 1
  context.globalCompositeOperation = 'source-over'
  context.drawImage(sample, sampleLeft, sampleTop)
}


// Device pixels. A leader shorter than six line widths (6 points on a 2x display) reads as a stub, so it is left out.
const CALLOUT_LINE_WIDTH = 2, CALLOUT_LEADER_MIN = 6 * CALLOUT_LINE_WIDTH
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
  context.lineWidth = CALLOUT_LINE_WIDTH / transform.a
  if (Math.hypot(leader.to.x - leader.from.x, leader.to.y - leader.from.y) * transform.a >= CALLOUT_LEADER_MIN) {
    context.beginPath(); context.moveTo(leader.from.x, leader.from.y); context.lineTo(leader.to.x, leader.to.y); context.stroke()
  }
  context.strokeRect(source.x, source.y, source.width, source.height)
  const radius = Math.min(10 / transform.a, bubble.width / 2, bubble.height / 2)
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
