import type { NativeImage } from 'electron'
import { pngBytes, pngFromBytes, PNG_MAX_DIMENSION, PNG_MAX_PIXELS } from '@agentmux/native-desktop/image'
import type { BrowserPng } from '../shared/contracts.js'

/** Existing image consumers use the same PNG contract as OS and page captures. */
export function browserPngFromBytes(png: Buffer): BrowserPng {
  return pngFromBytes(png)
}

/** Validate the original render surface before asking Electron to allocate its PNG. */
export function browserPagePixels(image: NativeImage): { png: Buffer; width: number; height: number } {
  if (image.isEmpty()) throw new Error('Browser screenshot is empty')
  const { width, height } = image.getSize()
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION || width * height > PNG_MAX_PIXELS) {
    throw new Error('Browser screenshot dimensions exceed the image limit')
  }
  return { png: image.toPNG(), width, height }
}

/** Export the original raster; CDP clip capture can overwrite Electron's device emulation. */
export function exportBrowserPageImage(image: NativeImage, pixelsPerCssPixel: number,
  region: { x: number; y: number; width: number; height: number; pixelRatio: number }): NativeImage {
  const size = image.getSize()
  // Quantize only to original raster pixels. Request validation and output budgets
  // already belong to prepareBrowserScreenshot; no page geometry is changed here.
  const x = Math.min(size.width - 1, Math.round(region.x * pixelsPerCssPixel)), y = Math.min(size.height - 1, Math.round(region.y * pixelsPerCssPixel))
  const right = Math.min(size.width, Math.max(x + 1, Math.round((region.x + region.width) * pixelsPerCssPixel)))
  const bottom = Math.min(size.height, Math.max(y + 1, Math.round((region.y + region.height) * pixelsPerCssPixel)))
  const cropped = x === 0 && y === 0 && right === size.width && bottom === size.height
    ? image : image.crop({ x, y, width: right - x, height: bottom - y })
  return cropped.resize({ width: Math.ceil(region.width * region.pixelRatio), height: Math.ceil(region.height * region.pixelRatio), quality: 'best' })
}

export function nativeImageFromBrowserPng(
  input: BrowserPng,
  createFromBuffer: (buffer: Buffer) => NativeImage
): NativeImage {
  const png = pngBytes(input)
  const image = createFromBuffer(png)
  if (image.isEmpty()) throw new Error('Clipboard image could not be decoded')
  const { width, height } = image.getSize()
  if (width !== input.width || height !== input.height) throw new Error('Clipboard image dimensions do not match the PNG')
  return image
}
