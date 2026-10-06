// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import {
  BROWSER_PNG_MAX_BYTES,
  BROWSER_PNG_MAX_DIMENSION,
  BROWSER_PNG_MAX_PIXELS,
  type BrowserPng
} from '../../../../shared/contracts'
import { intersectRect, scaleShape, screenshotOutputShapes, type NormalizedRect, type ScreenshotShape } from '../image-annotation/drawing-model'
import { drawScreenshotShapes } from '../image-annotation/drawing-renderer'

export const SCREENSHOT_DOWNSCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.3] as const

export { clampScreenshotScale } from '../image-annotation/geometry'
import { clampScreenshotScale } from '../image-annotation/geometry'

export function screenshotCanvasSize(
  displayWidth: number,
  displayHeight: number,
  outputScale: number
): { width: number; height: number; scale: number } {
  if (!Number.isFinite(displayWidth) || !Number.isFinite(displayHeight) || displayWidth <= 0 || displayHeight <= 0) {
    throw new Error('Screenshot editor has no drawable area')
  }
  const requested = clampScreenshotScale(outputScale)
  const pixelScale = Math.sqrt(BROWSER_PNG_MAX_PIXELS / (displayWidth * displayHeight))
  const dimensionScale = Math.min(
    BROWSER_PNG_MAX_DIMENSION / displayWidth,
    BROWSER_PNG_MAX_DIMENSION / displayHeight
  )
  const scale = Math.min(requested, pixelScale, dimensionScale)
  return {
    width: Math.max(1, Math.floor(displayWidth * scale)),
    height: Math.max(1, Math.floor(displayHeight * scale)),
    scale
  }
}

export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const payload = dataUrl.slice(comma + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding)
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas')
  element.width = Math.max(1, Math.floor(width))
  element.height = Math.max(1, Math.floor(height))
  return element
}

export function screenshotCropGeometry(displayWidth: number, displayHeight: number, outputScale: number, crop?: NormalizedRect | null) {
  const size = screenshotCanvasSize(displayWidth, displayHeight, outputScale)
  const rect = crop ? intersectRect(crop, { x: 0, y: 0, width: displayWidth, height: displayHeight }) : { x: 0, y: 0, width: displayWidth, height: displayHeight }
  if (!rect) throw new Error('Screenshot crop is outside the captured image')
  const left = Math.max(0, Math.floor(rect.x * size.scale)), top = Math.max(0, Math.floor(rect.y * size.scale))
  const right = Math.min(size.width, Math.ceil((rect.x + rect.width) * size.scale))
  const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height) * size.scale))
  return { ...size, left, top, cropWidth: right - left, cropHeight: bottom - top, rect }
}

function renderComposite(input: {
  image: CanvasImageSource
  displayWidth: number
  displayHeight: number
  outputScale: number
  shapes: readonly ScreenshotShape[]
  crop?: NormalizedRect | null
}): HTMLCanvasElement {
  const size = screenshotCropGeometry(input.displayWidth, input.displayHeight, input.outputScale, input.crop)
  const output = canvas(size.width, size.height)
  const context = output.getContext('2d')
  if (!context) throw new Error('Screenshot compose requires a 2D canvas')
  context.drawImage(input.image, 0, 0, size.width, size.height)
  drawScreenshotShapes(context, screenshotOutputShapes(input.shapes, input.crop).map((shape) => scaleShape(shape, size.scale)))
  if (!input.crop) return output
  const cropped = canvas(size.cropWidth, size.cropHeight)
  const target = cropped.getContext('2d')
  if (!target) throw new Error('Screenshot crop requires a 2D canvas')
  target.drawImage(output, size.left, size.top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height)
  return cropped
}

function downscale(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  if (factor === 1) return source
  const output = canvas(source.width * factor, source.height * factor)
  const context = output.getContext('2d')
  if (!context) throw new Error('Screenshot downscale requires a 2D canvas')
  context.drawImage(source, 0, 0, output.width, output.height)
  return output
}

function pngDataUrl(source: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    source.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Screenshot PNG encoding failed'))
        return
      }
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('Screenshot PNG could not be read'))
      reader.readAsDataURL(blob)
    }, 'image/png')
  })
}

export async function composeScreenshot(input: {
  image: CanvasImageSource
  displayWidth: number
  displayHeight: number
  outputScale: number
  shapes: readonly ScreenshotShape[]
  crop?: NormalizedRect | null
}): Promise<BrowserPng> {
  const composite = renderComposite(input)
  for (const step of SCREENSHOT_DOWNSCALE_STEPS) {
    const output = downscale(composite, step)
    const dataUrl = await pngDataUrl(output)
    const byteLength = dataUrlByteLength(dataUrl)
    if (byteLength <= BROWSER_PNG_MAX_BYTES) {
      return {
        mimeType: 'image/png',
        dataUrl,
        width: output.width,
        height: output.height,
        byteLength
      }
    }
  }
  throw new Error('Screenshot remains above the image byte limit after downscaling')
}
