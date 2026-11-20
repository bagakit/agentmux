import { renderAmuxProtocol } from './amux-protocol.js'
import { AMUX_PROTOCOL_DEFINITIONS, type CapsuleAnswer } from './amux-protocol-definition.js'
import { isObjectId } from './object-id.js'

export type { CapsuleAnswer }

const FIELDS = ['capsuleId', 'interactionId', 'question', 'answer'] as const

/** Exact object IDs address the page and question; the texts only need to be present. */
const valid = (value: Record<string, unknown>): boolean => isObjectId(value.capsuleId) && isObjectId(value.interactionId) &&
  typeof value.question === 'string' && !!value.question && typeof value.answer === 'string' && !!value.answer
const tag = AMUX_PROTOCOL_DEFINITIONS['capsule-answer'].tag
const opening = `<${tag} version="1">\n`, closing = `\n</${tag}>`

function json(value: CapsuleAnswer): string {
  return JSON.stringify(Object.fromEntries(FIELDS.map(field => [field, value[field]])))
    .replace(/[<>&]/gu, char => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char]!)
}

/** Readable wire only. The trusted confirmation and Core input receipt own human source and delivery. */
export function formatCapsuleAnswer(value: CapsuleAnswer): string {
  if (!valid(value)) throw new TypeError('A Capsule answer needs its exact page and question IDs, question text and answer.')
  return renderAmuxProtocol('capsule-answer', 'wire', { json: json(value) })
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
  if (Object.keys(record).join() !== FIELDS.join() || !valid(record)) return null
  const value = record as CapsuleAnswer
  return json(value) === line ? value : null
}
