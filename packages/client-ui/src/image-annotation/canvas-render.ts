// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import { clampScreenshotScale } from './geometry.js'
import { clipMarkArea, drawScreenshotShapes } from './drawing-renderer.js'
import { isScreenshotMask, screenshotOutputLayer, shapeBounds, type ScreenshotShape } from './drawing-model.js'
import type { ImageViewport } from './view.js'

function prepare(canvas: HTMLCanvasElement, viewport: ImageViewport): CanvasRenderingContext2D | null {
  const dpr = clampScreenshotScale(viewport.dpr)
  const width = Math.max(1, Math.round(viewport.width * dpr)), height = Math.max(1, Math.round(viewport.height * dpr))
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
  const context = canvas.getContext('2d')
  if (!context) return null
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, width, height)
  applyView(context, viewport)
  return context
}

function applyView(context: CanvasRenderingContext2D, viewport: ImageViewport) {
  const dpr = clampScreenshotScale(viewport.dpr), view = viewport.view
  context.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y)
}

type AdjustedBase = { source: string | null; adjustments: readonly ScreenshotShape[]; width: number; height: number; canvas: HTMLCanvasElement }
const adjustedBases = new WeakMap<CanvasImageSource, AdjustedBase>()
/** The image with its adjust marks applied, in image pixels. Adjustments paint before every other mark, so this base
 * depends only on the image and those marks, never on the view: pan and zoom reuse it. Marks are immutable, so the same
 * mark objects mean the same parameters and range; any change replaces a mark and repaints the base once. An image
 * element is the same pixels while its source is; other sources are kept unchanged by their owner while they paint. */
function adjustedBase(image: CanvasImageSource, width: number, height: number, adjustments: readonly ScreenshotShape[], document: Document): CanvasImageSource {
  if (!adjustments.length) { adjustedBases.delete(image); return image }
  const cached = adjustedBases.get(image), source = 'currentSrc' in image ? image.currentSrc || image.src : null
  if (cached && cached.source === source && cached.width === width && cached.height === height && cached.adjustments.length === adjustments.length &&
    cached.adjustments.every((shape, index) => shape === adjustments[index])) return cached.canvas
  const canvas = cached?.canvas ?? document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width)); canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Screenshot adjustment requires a 2D canvas')
  context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, width, height)
  drawScreenshotShapes(context, adjustments)
  adjustedBases.set(image, { source, adjustments, width, height, canvas })
  return canvas
}

/** Only viewport-sized bitmaps are allocated per view, even at high image magnification; adjustments keep one
 * image-sized base while they exist. */
export function renderCommittedLayer(layer: HTMLCanvasElement, shapes: readonly ScreenshotShape[], viewport: ImageViewport, image?: CanvasImageSource): void {
  const context = prepare(layer, viewport)
  if (!context) return
  // Adjustments paint first in output order. Without the image there is nothing to adjust yet; they paint once it loads.
  const adjustments = image ? shapes.filter(shape => shape.kind === 'adjust') : []
  context.save()
  try {
    context.beginPath(); context.rect(0, 0, viewport.imageWidth, viewport.imageHeight); context.clip()
    if (image) context.drawImage(adjustedBase(image, viewport.imageWidth, viewport.imageHeight, adjustments, layer.ownerDocument), 0, 0, viewport.imageWidth, viewport.imageHeight)
    drawScreenshotShapes(context, adjustments.length ? shapes.filter(shape => shape.kind !== 'adjust') : shapes)
  } finally { context.restore() }
}

/** `inProgress` is the mark under the pointer, or every mark of a group being moved, drawn above the cached committed layer. */
export function renderScreenshotScene(target: HTMLCanvasElement, committed: HTMLCanvasElement,
  inProgress: ScreenshotShape | readonly ScreenshotShape[] | null, viewport: ImageViewport, masks: readonly ScreenshotShape[] = []): void {
  const moving = inProgress === null ? [] : Array.isArray(inProgress) ? inProgress as readonly ScreenshotShape[] : [inProgress as ScreenshotShape]
  const context = prepare(target, viewport)
  if (!context) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  if (committed.width && committed.height) context.drawImage(committed, 0, 0)
  applyView(context, viewport)
  if (moving.length) {
    context.save()
    try {
      context.beginPath(); context.rect(0, 0, viewport.imageWidth, viewport.imageHeight); context.clip()
      drawScreenshotShapes(context, moving)
    } finally { context.restore() }
  }
  // Restore already processed mask pixels instead of resampling pixelation on each frame. Pointing marks paint above
  // masks in the output, so they keep painting above them here; a moving mask draws its own pixels.
  if (moving.some(shape => screenshotOutputLayer(shape) > 1)) masks = []
  if (moving.length && !moving.some(isScreenshotMask) && masks.length) {
    const { view } = viewport, dpr = clampScreenshotScale(viewport.dpr)
    context.setTransform(1, 0, 0, 1, 0, 0)
    for (const mask of masks) {
      if (!isScreenshotMask(mask)) continue
      const rect = shapeBounds(mask)
      const x = Math.max(0, Math.floor((view.x + rect.x * view.scale) * dpr))
      const y = Math.max(0, Math.floor((view.y + rect.y * view.scale) * dpr))
      const right = Math.min(target.width, Math.ceil((view.x + (rect.x + rect.width) * view.scale) * dpr))
      const bottom = Math.min(target.height, Math.ceil((view.y + (rect.y + rect.height) * view.scale) * dpr))
      if (right > x && bottom > y) {
        // The mask's own area, never its whole rect: live ink in a wand outline's notch or beside a brush corridor stays visible.
        context.save()
        applyView(context, viewport); clipMarkArea(context, mask); context.setTransform(1, 0, 0, 1, 0, 0)
        context.drawImage(committed, x, y, right - x, bottom - y, x, y, right - x, bottom - y)
        context.restore()
      }
    }
    applyView(context, viewport)
  }
}
