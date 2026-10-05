export const MOTE_FACE_PARTS = {
  shape: ['round', 'soft', 'square', 'slim', 'diamond'],
  palette: ['mint', 'peach', 'lavender', 'sky', 'cocoa', 'sand', 'rose', 'slate'],
  eyes: ['round', 'oval', 'spark', 'calm', 'lashes', 'wink'],
  brows: ['soft', 'straight', 'curious', 'bold', 'arched', 'angled'],
  mouth: ['smile', 'small', 'grin', 'cat', 'smirk', 'tooth'],
  accessory: ['none', 'tuft', 'antenna', 'swept', 'curls', 'glasses', 'ears', 'horns', 'beard'],
  nose: ['none', 'button', 'bridge', 'round'],
  marking: ['none', 'freckles', 'blush', 'scar']
} as const
const optionalParts = new Set(['nose', 'marking'])
type Parts = { [K in keyof typeof MOTE_FACE_PARTS]: (typeof MOTE_FACE_PARTS)[K][number] }
export type MoteFace = { kind: 'face' } & Omit<Parts, 'nose' | 'marking'> & Partial<Pick<Parts, 'nose' | 'marking'>>
export const DEFAULT_MOTE_FACE: MoteFace = { kind: 'face', shape: 'soft', palette: 'mint', eyes: 'round', brows: 'soft', mouth: 'smile', accessory: 'tuft' }
export function isMoteFace(value: unknown): value is MoteFace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const face = value as Record<string, unknown>
  return Object.hasOwn(face, 'kind') && face.kind === 'face' && Object.keys(face).every(key => key === 'kind' || Object.hasOwn(MOTE_FACE_PARTS, key)) &&
    Object.entries(MOTE_FACE_PARTS).every(([part, choices]) =>
      !Object.hasOwn(face, part) ? optionalParts.has(part) : typeof face[part] === 'string' && (choices as readonly string[]).includes(face[part] as string))
}
