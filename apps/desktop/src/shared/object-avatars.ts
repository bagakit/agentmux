/** Image bytes are transient; the existing Space preference holds only a content reference. */
export const AVATAR_INPUT_MAX_BYTES = 8 * 1024 * 1024
export const AVATAR_MAX_DIMENSION = 4096
export const AVATAR_MAX_PIXELS = 16 * 1024 * 1024
export const AVATAR_EDGE = 256
export const AVATAR_OUTPUT_MAX_BYTES = 512 * 1024
export const AVATAR_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
export type ObjectAvatarRef = { kind: 'image'; fileName: string }
export type ObjectAvatarInput = { mimeType: 'image/png' | 'image/jpeg'; dataUrl: string }
export type ObjectAvatarImage = { dataUrl: string; width: number; height: number }
export type SpaceObjectImageTarget =
  | { kind: 'category'; categoryId: string; objectKey: string }
  | { kind: 'topic'; workspaceId: string; topicId: string; objectKey: string }
export type SpaceObjectAppearance = { icon: string | null; local: boolean }

export function isObjectAvatarRef(value: unknown): value is ObjectAvatarRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<ObjectAvatarRef>
  return ref.kind === 'image' && typeof ref.fileName === 'string' && /^[a-f0-9]{64}\.png$/.test(ref.fileName) && Object.keys(ref).length === 2
}
/** The caller supplies identities only; Main resolves all resource paths from original owners. */
export function requireSpaceObjectImageTarget(value: unknown): asserts value is SpaceObjectImageTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose an exact Category or Topic image target.')
  const target = value as Record<string, unknown>
  const keys = target.kind === 'category' ? ['kind', 'categoryId', 'objectKey'] : target.kind === 'topic' ? ['kind', 'workspaceId', 'topicId', 'objectKey'] : []
  if (!keys.length || Object.keys(target).length !== keys.length || keys.some(key => !Object.hasOwn(target, key) || typeof target[key] !== 'string' || !target[key]))
    throw new Error('Choose an exact Category or Topic image target.')
}
