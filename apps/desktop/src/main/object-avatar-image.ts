import type { NativeImage } from 'electron'
import {
  AVATAR_INPUT_MAX_BYTES, AVATAR_MAX_DIMENSION, AVATAR_MAX_PIXELS,
  AVATAR_PREVIEW_MAX_BYTES, AVATAR_OUTPUT_MAX_BYTES, AVATAR_EDGE,
  type ObjectAvatarInput, type ObjectAvatarImage
} from '../shared/object-avatars.js'

type ImageSize = { width: number; height: number }
function assertSize({ width, height }: ImageSize): void {
  if (width < 1 || height < 1 || width > AVATAR_MAX_DIMENSION || height > AVATAR_MAX_DIMENSION || width * height > AVATAR_MAX_PIXELS)
    throw new Error('Choose an image at most 4096 pixels per side and 16 megapixels.')
}
/** Inspect encoded dimensions before native decoding can allocate the image. */
function staticImage(bytes: Buffer, mime: ObjectAvatarInput['mimeType']): ImageSize {
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset] !== 255) break
      if (bytes[offset + 1] === 255) { offset++; continue }
      const marker = bytes[offset + 1]!, length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) break
      if ([192, 193, 194].includes(marker) && length >= 8)
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
      offset += 2 + length
    }
  } else if (mime === 'image/png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
      if (type === 'acTL') throw new Error('Choose a static PNG or JPEG image.')
      if (offset + length + 12 > bytes.length) throw new Error('The PNG is incomplete.')
      offset += length + 12
      if (type === 'IEND' && length === 0 && offset === bytes.length) return size
    }
  }
  throw new Error('Choose a valid static PNG or JPEG image.')
}

export function decodeObjectAvatar(input: ObjectAvatarInput, createImage: (bytes: Buffer) => NativeImage): NativeImage {
  if (!input || !['image/png', 'image/jpeg'].includes(input.mimeType)) throw new Error('Choose a static PNG or JPEG image.')
  const prefix = `data:${input.mimeType};base64,`
  if (typeof input.dataUrl !== 'string' || !input.dataUrl.startsWith(prefix)) throw new Error('Image data does not match its format.')
  const data = input.dataUrl.slice(prefix.length)
  if (!data || data.length > Math.ceil(AVATAR_INPUT_MAX_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Image data is invalid or exceeds 8 MiB.')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > AVATAR_INPUT_MAX_BYTES) throw new Error('Choose an image smaller than 8 MiB.')
  const encoded = staticImage(bytes, input.mimeType)
  assertSize(encoded)
  const image = createImage(bytes)
  if (image.isEmpty()) throw new Error('The image could not be decoded.')
  const decoded = image.getSize()
  assertSize(decoded)
  if (decoded.width !== encoded.width || decoded.height !== encoded.height) throw new Error('The decoded image does not match its original dimensions.')
  return image
}
export function previewObjectAvatar(image: NativeImage): ObjectAvatarImage {
  const size = image.getSize(), scale = Math.min(1, 512 / Math.max(size.width, size.height))
  const resized = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' })
  const png = resized.toPNG()
  if (png.length > AVATAR_PREVIEW_MAX_BYTES) throw new Error('The image preview exceeds its limit.')
  return { dataUrl: 'data:image/png;base64,' + png.toString('base64'), ...resized.getSize() }
}
export function objectAvatarPng(image: NativeImage): Buffer {
  const { width, height } = image.getSize()
  if (width !== AVATAR_EDGE || height !== AVATAR_EDGE) throw new Error('Save the 256 pixel avatar crop.')
  const png = image.toPNG()
  if (!png.length || png.length > AVATAR_OUTPUT_MAX_BYTES) throw new Error('The avatar crop exceeds 512 KiB.')
  return png
}
