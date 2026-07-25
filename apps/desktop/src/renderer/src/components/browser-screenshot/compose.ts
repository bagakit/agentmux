// Portions adapted from Orca commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e.
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import {
  BROWSER_PNG_MAX_BYTES,
  BROWSER_PNG_MAX_DIMENSION,
  BROWSER_PNG_MAX_PIXELS,
  type BrowserPng
} from '../../../../shared/contracts'
import { scaleShape, type ScreenshotShape } from './drawing-model'
import { drawScreenshotShapes } from './drawing-renderer'

export const SCREENSHOT_DOWNSCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.3] as const

export function clampScreenshotScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(Math.max(scale, 1), 4)
}

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

function renderComposite(input: {
  image: CanvasImageSource
  displayWidth: number
  displayHeight: number
  outputScale: number
  shapes: readonly ScreenshotShape[]
}): HTMLCanvasElement {
  const size = screenshotCanvasSize(input.displayWidth, input.displayHeight, input.outputScale)
  const output = canvas(size.width, size.height)
  const context = output.getContext('2d')
  if (!context) throw new Error('Screenshot compose requires a 2D canvas')
  context.drawImage(input.image, 0, 0, size.width, size.height)
  drawScreenshotShapes(context, input.shapes.map((shape) => scaleShape(shape, size.scale)))
  return output
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
