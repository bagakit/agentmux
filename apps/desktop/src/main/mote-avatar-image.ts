import type { NativeImage } from 'electron'
import {
  MOTE_AVATAR_INPUT_MAX_BYTES, MOTE_AVATAR_MAX_DIMENSION, MOTE_AVATAR_MAX_PIXELS,
  MOTE_AVATAR_PREVIEW_MAX_BYTES, MOTE_AVATAR_OUTPUT_MAX_BYTES, MOTE_AVATAR_EDGE,
  type MoteAvatarInput, type MoteAvatarImage
} from '../shared/mote-avatars.js'

function staticImage(bytes: Buffer, mime: MoteAvatarInput['mimeType']): void {
  if (mime === 'image/jpeg') {
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return
  } else if (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
      if (type === 'acTL') throw new Error('Choose a static PNG or JPEG image.')
      if (offset + length + 12 > bytes.length) throw new Error('The PNG is incomplete.')
      offset += length + 12
      if (type === 'IEND') return
    }
  }
  throw new Error('Choose a valid static PNG or JPEG image.')
}

export function decodeMoteAvatar(input: MoteAvatarInput, createImage: (bytes: Buffer) => NativeImage): NativeImage {
  if (!input || !['image/png', 'image/jpeg'].includes(input.mimeType)) throw new Error('Choose a static PNG or JPEG image.')
  const prefix = `data:${input.mimeType};base64,`
  if (typeof input.dataUrl !== 'string' || !input.dataUrl.startsWith(prefix)) throw new Error('Image data does not match its format.')
  const data = input.dataUrl.slice(prefix.length)
  if (!data || data.length > Math.ceil(MOTE_AVATAR_INPUT_MAX_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Image data is invalid or exceeds 8 MiB.')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > MOTE_AVATAR_INPUT_MAX_BYTES) throw new Error('Choose an image smaller than 8 MiB.')
  staticImage(bytes, input.mimeType)
  const image = createImage(bytes)
  if (image.isEmpty()) throw new Error('The image could not be decoded.')
  const { width, height } = image.getSize()
  if (width < 1 || height < 1 || width > MOTE_AVATAR_MAX_DIMENSION || height > MOTE_AVATAR_MAX_DIMENSION || width * height > MOTE_AVATAR_MAX_PIXELS) throw new Error('Choose an image at most 4096 pixels per side and 16 megapixels.')
  return image
}
export function previewMoteAvatar(image: NativeImage): MoteAvatarImage {
  const size = image.getSize(), scale = Math.min(1, 512 / Math.max(size.width, size.height))
  const resized = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' })
  const png = resized.toPNG()
  if (png.length > MOTE_AVATAR_PREVIEW_MAX_BYTES) throw new Error('The image preview exceeds its limit.')
  return { dataUrl: 'data:image/png;base64,' + png.toString('base64'), ...resized.getSize() }
}
export function moteAvatarPng(image: NativeImage): Buffer {
  const { width, height } = image.getSize()
  if (width !== MOTE_AVATAR_EDGE || height !== MOTE_AVATAR_EDGE) throw new Error('Save the 256 pixel avatar crop.')
  const png = image.toPNG()
  if (!png.length || png.length > MOTE_AVATAR_OUTPUT_MAX_BYTES) throw new Error('The avatar crop exceeds 512 KiB.')
  return png
}
