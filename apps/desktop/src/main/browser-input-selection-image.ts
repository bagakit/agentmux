import { createHash } from 'node:crypto'
import type { NativeImage } from 'electron'
import type { BrowserPng } from '../shared/contracts.js'
import { nativeImageFromBrowserPng } from './browser-image.js'
import { savePastedImage } from './pasted-image-write.js'
import { readPastedImage } from './pasted-image-read.js'
import type { BrowserInputImageReference } from '@agentmux/core/browser-input-context'
import { browserPngFromBytes } from './browser-image.js'

/** Decode only the explicit processed output; the original frame is never stored here. */
export function decodeBrowserInputSelectionPng(png: BrowserPng, createFromBuffer: (bytes: Buffer) => NativeImage) {
  const image = nativeImageFromBrowserPng(png, createFromBuffer)
  const bytes = Buffer.from(png.dataUrl.slice('data:image/png;base64,'.length), 'base64')
  return { bytes, ...image.getSize(), sha256: createHash('sha256').update(bytes).digest('hex') }
}

export function browserInputSelectionImages(home: string, createFromBuffer: (bytes: Buffer) => NativeImage) {
  return { decode: (png: BrowserPng) => decodeBrowserInputSelectionPng(png, createFromBuffer),
    save: (bytes: Buffer) => savePastedImage(home, { bytes, extension: 'png' }) }
}

/** Exact reference observation; a missing/mismatched resource stays visible as its original reference. */
export async function readBrowserInputSelectionImage(home: string, hostId: string, reference: BrowserInputImageReference,
  createFromBuffer: (bytes: Buffer) => NativeImage) {
  if (!reference || reference.hostId !== hostId || reference.mimeType !== 'image/png' ||
      typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.sha256) ||
      typeof reference.path !== 'string' || !Number.isSafeInteger(reference.width) || reference.width < 1 ||
      !Number.isSafeInteger(reference.height) || reference.height < 1) return null
  reference = { ...reference }
  try {
    const image = await readPastedImage(home, reference.path)
    if (!image || !image.dataUrl.startsWith('data:image/png;base64,')) return null
    const bytes = Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64')
    const png = browserPngFromBytes(bytes)
    if (png.width !== reference.width || png.height !== reference.height || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) return null
    nativeImageFromBrowserPng(png, createFromBuffer)
    return image
  } catch { return null }
}
