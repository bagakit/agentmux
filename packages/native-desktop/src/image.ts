/** Shared PNG boundary. Page pixels stay with the caller's GUI/CDP owner. */
export interface NativePng {
  mimeType: 'image/png'
  dataUrl: string
  width: number
  height: number
  byteLength: number
}

export const PNG_MAX_BYTES = 18 * 1024 * 1024
export const PNG_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const PNG_MAX_DIMENSION = 16_384
export const PNG_MAX_PIXELS = 32 * 1024 * 1024
const PREFIX = 'data:image/png;base64,'
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (png.byteLength < 33 || png.byteLength > PNG_MAX_BYTES ||
      !png.subarray(0, 8).equals(SIGNATURE) || png.readUInt32BE(8) !== 13 ||
      png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Image must be a bounded PNG with an IHDR header')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width < 1 || height < 1 || width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION ||
      width * height > PNG_MAX_PIXELS) throw new Error('PNG dimensions exceed the image limit')
  return { width, height }
}

export function pngFromBytes(bytes: Uint8Array): NativePng {
  const dimensions = pngDimensions(bytes)
  return { mimeType: 'image/png', dataUrl: PREFIX + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
    ...dimensions, byteLength: bytes.byteLength }
}

export function pngBytes(image: NativePng): Buffer {
  if (!image || image.mimeType !== 'image/png' || typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith(PREFIX)) {
    throw new Error('Image must be a PNG data URL')
  }
  const payload = image.dataUrl.slice(PREFIX.length)
  if (!payload.length || payload.length > PNG_MAX_BASE64_CHARS || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error('Image must contain bounded base64 PNG data')
  }
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.byteLength !== image.byteLength || bytes.toString('base64') !== payload) throw new Error('PNG byte length is invalid')
  const dimensions = pngDimensions(bytes)
  if (dimensions.width !== image.width || dimensions.height !== image.height) throw new Error('PNG dimensions do not match its metadata')
  return bytes
}

export interface PageImagePort {
  capture(): Promise<{ png: Uint8Array; width?: number; height?: number }>
}

/** No native process, permission read, focus change or extra image encoding. */
export async function capturePageImage(port: PageImagePort): Promise<NativePng> {
  const result = await port.capture()
  const image = pngFromBytes(result.png)
  if ((result.width !== undefined && result.width !== image.width) || (result.height !== undefined && result.height !== image.height)) {
    throw new Error('Page pixel dimensions changed during capture')
  }
  return image
}
