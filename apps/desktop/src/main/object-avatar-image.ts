import type { NativeImage } from 'electron'
import { objectAvatarImageSize, assertObjectAvatarSize } from '@agentmux/host/object-avatar-files'
import {
  AVATAR_INPUT_MAX_BYTES,
  AVATAR_PREVIEW_MAX_BYTES, AVATAR_OUTPUT_MAX_BYTES, AVATAR_EDGE,
  type ObjectAvatarInput, type ObjectAvatarImage
} from '@agentmux/host/object-avatars'


export function decodeObjectAvatar(input: ObjectAvatarInput, createImage: (bytes: Buffer) => NativeImage): NativeImage {
  if (!input || !['image/png', 'image/jpeg'].includes(input.mimeType)) throw new Error('Choose a static PNG or JPEG image.')
  const prefix = `data:${input.mimeType};base64,`
  if (typeof input.dataUrl !== 'string' || !input.dataUrl.startsWith(prefix)) throw new Error('Image data does not match its format.')
  const data = input.dataUrl.slice(prefix.length)
  if (!data || data.length > Math.ceil(AVATAR_INPUT_MAX_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Image data is invalid or exceeds 8 MiB.')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > AVATAR_INPUT_MAX_BYTES) throw new Error('Choose an image smaller than 8 MiB.')
  const encoded = objectAvatarImageSize(bytes, input.mimeType)
  assertObjectAvatarSize(encoded)
  const image = createImage(bytes)
  if (image.isEmpty()) throw new Error('The image could not be decoded.')
  const decoded = image.getSize()
  assertObjectAvatarSize(decoded)
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
