import { nativeImage } from 'electron'
import { browserPngFromBytes, nativeImageFromBrowserPng } from './browser-image.js'

const PREFIX = 'data:image/png;base64,'
const MAX_BYTES = 64 * 1024

/** Cosmetic input only. A bad image never changes the original Browser operation's result. */
export function validateBrowserOperatorAvatarPng(png: string): string | undefined {
  try {
    if (typeof png !== 'string' || !png.startsWith(PREFIX)) return undefined
    const payload = png.slice(PREFIX.length)
    if (!payload || payload.length > 4 * Math.ceil(MAX_BYTES / 3) || payload.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) return undefined
    const bytes = Buffer.from(payload, 'base64')
    if (bytes.byteLength > MAX_BYTES || bytes.toString('base64') !== payload) return undefined
    const image = browserPngFromBytes(bytes)
    if (image.width !== 64 || image.height !== 64) return undefined
    nativeImageFromBrowserPng(image, value => nativeImage.createFromBuffer(value))
    return image.dataUrl
  } catch { return undefined }
}
