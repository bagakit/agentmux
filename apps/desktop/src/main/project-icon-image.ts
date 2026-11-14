import type { NativeImage } from 'electron'
import { assertObjectAvatarSize, objectAvatarImageSize } from '@agentmux/host/object-avatar-files'

export type ProjectIconDecoder = (bytes: Buffer) => NativeImage
export const PROJECT_ICON_OUTPUT_MAX_BYTES = 256 * 1024
const MAX_EDGE = 512

/** Optional local artwork is bounded before native decoding and before publication. */
export function projectIconImage(bytes: Buffer, mime: string, decode: ProjectIconDecoder): { bytes: Buffer; mime: string } | null {
  if (mime !== 'image/png' && mime !== 'image/jpeg')
    return bytes.length <= PROJECT_ICON_OUTPUT_MAX_BYTES ? { bytes, mime } : null
  try {
    const size = objectAvatarImageSize(bytes, mime)
    assertObjectAvatarSize(size)
    if (Math.max(size.width, size.height) <= MAX_EDGE && bytes.length <= PROJECT_ICON_OUTPUT_MAX_BYTES) return { bytes, mime }
    const image = decode(bytes)
    if (image.isEmpty()) return null
    const decoded = image.getSize()
    assertObjectAvatarSize(decoded)
    if (decoded.width !== size.width || decoded.height !== size.height) return null
    const scale = Math.min(1, MAX_EDGE / Math.max(size.width, size.height))
    const resized = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' })
    const output = resized.toPNG(), result = resized.getSize()
    if (!output.length || output.length > PROJECT_ICON_OUTPUT_MAX_BYTES || Math.max(result.width, result.height) > MAX_EDGE) return null
    return { bytes: output, mime: 'image/png' }
  } catch {
    // Invalid or undecodable artwork can yield to another candidate, never disable its project.
    return null
  }
}
