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
