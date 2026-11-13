import { AMUX_PROTOCOL_DEFINITIONS, type CapsuleAnswer } from './amux-protocol-definition.js'

export type { CapsuleAnswer }

const FIELDS = ['capsuleId', 'interactionId', 'question', 'answer'] as const
const tag = AMUX_PROTOCOL_DEFINITIONS['capsule-answer'].tag
const opening = `<${tag} version="1">\n`, closing = `\n</${tag}>`

function json(value: CapsuleAnswer): string {
  return JSON.stringify(Object.fromEntries(FIELDS.map(field => [field, value[field]])))
    .replace(/[<>&]/gu, char => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char]!)
}

/** Readable wire only. The trusted confirmation and Core input receipt own human source and delivery. */
export function formatCapsuleAnswer(value: CapsuleAnswer): string {
  if (FIELDS.some(field => typeof value[field] !== 'string' || !value[field])) throw new TypeError('A Capsule answer needs its page, question, question text and answer.')
  return opening + json(value) + closing
}

/** Recognizes only the exact formatter output; anything else stays ordinary text. */
export function parseCapsuleAnswer(text: string): CapsuleAnswer | null {
  if (!text.startsWith(opening) || !text.endsWith(closing)) return null
  const line = text.slice(opening.length, -closing.length)
  if (line.includes('\n')) return null
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).join() !== FIELDS.join() || FIELDS.some(field => typeof record[field] !== 'string' || !record[field])) return null
  const value = record as CapsuleAnswer
  return json(value) === line ? value : null
}
