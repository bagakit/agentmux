import type { NativeImage } from 'electron'
import {
  BROWSER_PNG_MAX_BASE64_CHARS,
  BROWSER_PNG_MAX_BYTES,
  BROWSER_PNG_MAX_DIMENSION,
  BROWSER_PNG_MAX_PIXELS,
  type BrowserPng
} from '../shared/contracts.js'

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_IHDR_LENGTH = 13
const PNG_IHDR_TYPE = 'IHDR'

function assertImageSize(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > BROWSER_PNG_MAX_DIMENSION ||
    height > BROWSER_PNG_MAX_DIMENSION ||
    width * height > BROWSER_PNG_MAX_PIXELS
  ) {
    throw new Error('Browser screenshot dimensions exceed the image limit')
  }
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (
    png.byteLength < 33 ||
    !png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    png.readUInt32BE(8) !== PNG_IHDR_LENGTH ||
    png.toString('ascii', 12, 16) !== PNG_IHDR_TYPE
  ) {
    throw new Error('Clipboard image bytes are not a PNG with an IHDR header')
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assertImageSize(width, height)
  return { width, height }
}

export function browserPngFromNativeImage(image: NativeImage): BrowserPng {
  if (image.isEmpty()) throw new Error('Browser screenshot is empty')
  const { width, height } = image.getSize()
  assertImageSize(width, height)
  const png = image.toPNG()
  if (png.byteLength < 1 || png.byteLength > BROWSER_PNG_MAX_BYTES) {
    throw new Error('Browser screenshot exceeds the image byte limit')
  }
  const encodedSize = pngDimensions(png)
  if (encodedSize.width !== width || encodedSize.height !== height) {
    throw new Error('Browser screenshot dimensions do not match the PNG')
  }
  return {
    mimeType: 'image/png',
    dataUrl: `${PNG_DATA_URL_PREFIX}${png.toString('base64')}`,
    width,
    height,
    byteLength: png.byteLength
  }
}

export function nativeImageFromBrowserPng(
  input: BrowserPng,
  createFromBuffer: (buffer: Buffer) => NativeImage
): NativeImage {
  if (
    !input ||
    input.mimeType !== 'image/png' ||
    typeof input.dataUrl !== 'string' ||
    !input.dataUrl.startsWith(PNG_DATA_URL_PREFIX)
  ) {
    throw new Error('Clipboard image must be a PNG data URL')
  }
  const payload = input.dataUrl.slice(PNG_DATA_URL_PREFIX.length)
  if (
    payload.length === 0 ||
    payload.length > BROWSER_PNG_MAX_BASE64_CHARS ||
    payload.length % 4 !== 0 ||
    !BASE64_PATTERN.test(payload)
  ) {
    throw new Error('Clipboard image must contain bounded base64 PNG data')
  }
  const png = Buffer.from(payload, 'base64')
  if (
    png.byteLength < 1 ||
    png.byteLength > BROWSER_PNG_MAX_BYTES ||
    png.byteLength !== input.byteLength ||
    png.toString('base64') !== payload
  ) {
    throw new Error('Clipboard image byte length is invalid')
  }
  const encodedSize = pngDimensions(png)
  if (encodedSize.width !== input.width || encodedSize.height !== input.height) {
    throw new Error('Clipboard image dimensions do not match the PNG')
  }
  const image = createFromBuffer(png)
  if (image.isEmpty()) throw new Error('Clipboard image could not be decoded')
  const { width, height } = image.getSize()
  assertImageSize(width, height)
  if (width !== encodedSize.width || height !== encodedSize.height) {
    throw new Error('Clipboard image dimensions do not match the PNG')
  }
  return image
}
