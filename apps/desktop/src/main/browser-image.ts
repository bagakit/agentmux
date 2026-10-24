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
