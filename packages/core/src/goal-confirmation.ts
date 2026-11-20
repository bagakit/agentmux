import { AMUX_PROTOCOL_DEFINITIONS } from './amux-protocol-definition.js'
import { parseAmuxObjectLink } from './sharing.js'

export type GoalConfirmation = { goalUrl: string; alignmentRevision: number; operationId: string }

const tag = AMUX_PROTOCOL_DEFINITIONS['goal-confirmation'].tag
const opening = `<${tag} version="1" action="confirm-and-continue">\n`
const closing = `\n</${tag}>`

/** A declaration of the original operation. The Goal and Core receipts independently establish its effects. */
export function formatGoalConfirmation({ goalUrl, alignmentRevision, operationId }: GoalConfirmation): string {
  const target = parseAmuxObjectLink(goalUrl)
  if (target.kind !== 'goal' || !target.runtimeId || !target.namespace || target.section || target.nodeId ||
      !Number.isSafeInteger(alignmentRevision) || alignmentRevision < 1 ||
      typeof operationId !== 'string' || !operationId.trim() || operationId.includes('\0'))
    throw new TypeError('Goal continuation needs its exact original Goal address, confirmation revision and operation.')
  const body = JSON.stringify({ goalUrl, alignmentRevision, operationId })
    .replace(/[<>&]/gu, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[character]!)
  return opening + body + closing
}

export function parseGoalConfirmation(text: string): GoalConfirmation | null {
  if (!text.startsWith(opening) || !text.endsWith(closing)) return null
  try {
    const value: GoalConfirmation = JSON.parse(text.slice(opening.length, -closing.length))
    return formatGoalConfirmation(value) === text ? value : null
  } catch { return null }
}
