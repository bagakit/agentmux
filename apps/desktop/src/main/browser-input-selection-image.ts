import { createHash } from 'node:crypto'
import type { NativeImage } from 'electron'
import type { BrowserPng } from '../shared/contracts.js'
import { nativeImageFromBrowserPng } from './browser-image.js'
import { savePastedImage } from './pasted-image-write.js'

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
