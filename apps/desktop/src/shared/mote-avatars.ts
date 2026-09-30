/** Ephemeral image payloads and a content reference; the existing Space override owns the choice. */
export const MOTE_AVATAR_INPUT_MAX_BYTES = 8 * 1024 * 1024
export const MOTE_AVATAR_MAX_DIMENSION = 4096
export const MOTE_AVATAR_MAX_PIXELS = 16 * 1024 * 1024
export const MOTE_AVATAR_EDGE = 256
export const MOTE_AVATAR_OUTPUT_MAX_BYTES = 512 * 1024
export const MOTE_AVATAR_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
export type MoteAvatarTarget = { workspaceId: string; topicId: string; objectKey: string }
export type MoteAvatarRef = { kind: 'image'; fileName: string }
export type MoteAvatarInput = { mimeType: 'image/png' | 'image/jpeg'; dataUrl: string }
export type MoteAvatarImage = { dataUrl: string; width: number; height: number }
export function isMoteAvatarRef(value: unknown): value is MoteAvatarRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<MoteAvatarRef>
  return ref.kind === 'image' && typeof ref.fileName === 'string' && /^[a-f0-9]{64}\.png$/.test(ref.fileName) &&
    Object.keys(ref).length === 2
}
