// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import { clampScreenshotScale } from './geometry'
import { drawScreenshotShapes } from './drawing-renderer'
import { normalizeRect, type ScreenshotShape } from './drawing-model'
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

export function renderScreenshotScene(target: HTMLCanvasElement, committed: HTMLCanvasElement,
  inProgress: ScreenshotShape | null, viewport: ImageViewport, masks: readonly ScreenshotShape[] = []): void {
  const context = prepare(target, viewport)
  if (!context) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  if (committed.width && committed.height) context.drawImage(committed, 0, 0)
  applyView(context, viewport)
  if (inProgress) {
    context.save()
    try {
      context.beginPath(); context.rect(0, 0, viewport.imageWidth, viewport.imageHeight); context.clip()
      drawScreenshotShapes(context, [inProgress])
    } finally { context.restore() }
  }
  // Restore already processed mask pixels instead of resampling pixelation on each frame.
  if (inProgress && inProgress.kind !== 'pixelate' && inProgress.kind !== 'cover' && masks.length) {
    const { view } = viewport, dpr = clampScreenshotScale(viewport.dpr)
    context.setTransform(1, 0, 0, 1, 0, 0)
    for (const mask of masks) {
      if (mask.kind !== 'pixelate' && mask.kind !== 'cover') continue
      const rect = normalizeRect(mask.from, mask.to)
      const x = Math.max(0, Math.floor((view.x + rect.x * view.scale) * dpr))
      const y = Math.max(0, Math.floor((view.y + rect.y * view.scale) * dpr))
      const right = Math.min(target.width, Math.ceil((view.x + (rect.x + rect.width) * view.scale) * dpr))
      const bottom = Math.min(target.height, Math.ceil((view.y + (rect.y + rect.height) * view.scale) * dpr))
      if (right > x && bottom > y) context.drawImage(committed, x, y, right - x, bottom - y, x, y, right - x, bottom - y)
    }
    applyView(context, viewport)
  }
}
