// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import { clampScreenshotScale } from './compose'
import { drawScreenshotShapes } from './drawing-renderer'
import type { ScreenshotShape } from './drawing-model'

function scenePixels(cssWidth: number, cssHeight: number, dpr: number) {
  const scale = clampScreenshotScale(dpr)
  return {
    scale,
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale))
  }
}

export function renderCommittedLayer(
  layer: HTMLCanvasElement,
  shapes: readonly ScreenshotShape[],
  cssWidth: number,
  cssHeight: number,
  dpr: number
): void {
  const size = scenePixels(cssWidth, cssHeight, dpr)
  if (layer.width !== size.width || layer.height !== size.height) {
    layer.width = size.width
    layer.height = size.height
  }
  const context = layer.getContext('2d')
  if (!context) return
  context.setTransform(size.scale, 0, 0, size.scale, 0, 0)
  context.clearRect(0, 0, cssWidth, cssHeight)
  drawScreenshotShapes(context, shapes)
}

export function renderScreenshotScene(
  target: HTMLCanvasElement,
  committed: HTMLCanvasElement,
  inProgress: ScreenshotShape | null,
  cssWidth: number,
  cssHeight: number,
  dpr: number
): void {
  const context = target.getContext('2d')
  if (!context) return
  const size = scenePixels(cssWidth, cssHeight, dpr)
  if (target.width !== size.width || target.height !== size.height) {
    target.width = size.width
    target.height = size.height
  }
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, size.width, size.height)
  if (committed.width > 0 && committed.height > 0) {
    context.drawImage(committed, 0, 0, size.width, size.height)
  }
  context.setTransform(size.scale, 0, 0, size.scale, 0, 0)
  if (inProgress) drawScreenshotShapes(context, [inProgress])
}
