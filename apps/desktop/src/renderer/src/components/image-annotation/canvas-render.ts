// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import { clampScreenshotScale } from './geometry'
import { clipPixelateBrush, drawScreenshotShapes } from './drawing-renderer'
import { isScreenshotMask, screenshotOutputLayer, shapeBounds, type ScreenshotShape } from './drawing-model'
import type { ImageViewport } from './view'

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

/** Only viewport-sized bitmaps are allocated, even at high image magnification. */
export function renderCommittedLayer(layer: HTMLCanvasElement, shapes: readonly ScreenshotShape[], viewport: ImageViewport, image?: CanvasImageSource): void {
  const context = prepare(layer, viewport)
  if (!context) return
  context.save()
  try {
    context.beginPath(); context.rect(0, 0, viewport.imageWidth, viewport.imageHeight); context.clip()
    if (image) context.drawImage(image, 0, 0, viewport.imageWidth, viewport.imageHeight)
    drawScreenshotShapes(context, shapes)
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
        context.save()
        if (mask.kind === 'pixelate-brush') { applyView(context, viewport); clipPixelateBrush(context, mask); context.setTransform(1, 0, 0, 1, 0, 0) }
        context.drawImage(committed, x, y, right - x, bottom - y, x, y, right - x, bottom - y)
        context.restore()
      }
    }
    applyView(context, viewport)
  }
}
