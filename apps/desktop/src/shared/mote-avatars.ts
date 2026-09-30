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

/** Small, authored parts. No markup, executable text or remote resources are accepted. */
export const MOTE_FACE_PARTS = {
  shape: ['round', 'soft', 'square'],
  palette: ['mint', 'peach', 'lavender', 'sky'],
  eyes: ['round', 'oval', 'spark'],
  brows: ['soft', 'straight', 'curious'],
  mouth: ['smile', 'small', 'grin'],
  accessory: ['none', 'tuft', 'antenna']
} as const
export type MoteFace = { kind: 'face' } & { [K in keyof typeof MOTE_FACE_PARTS]: (typeof MOTE_FACE_PARTS)[K][number] }
export const DEFAULT_MOTE_FACE: MoteFace = { kind: 'face', shape: 'soft', palette: 'mint', eyes: 'round', brows: 'soft', mouth: 'smile', accessory: 'tuft' }
export function isMoteFace(value: unknown): value is MoteFace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const face = value as Record<string, unknown>
  return face.kind === 'face' && Object.keys(face).length === Object.keys(MOTE_FACE_PARTS).length + 1 &&
    Object.entries(MOTE_FACE_PARTS).every(([part, choices]) => typeof face[part] === 'string' && (choices as readonly string[]).includes(face[part] as string))
}
export function isMoteAvatarRef(value: unknown): value is MoteAvatarRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<MoteAvatarRef>
  return ref.kind === 'image' && typeof ref.fileName === 'string' && /^[a-f0-9]{64}\.png$/.test(ref.fileName) &&
    Object.keys(ref).length === 2
}
