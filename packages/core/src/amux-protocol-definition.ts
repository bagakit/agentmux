import { AMUX_PROTOCOL_DEFINITIONS, encodeAmuxText, renderAmuxProtocol } from './amux-protocol.js'

export { AMUX_PROTOCOL_DEFINITIONS, type AmuxProtocolId } from './amux-protocol.js'

export const AMUX_TRIGGER_KINDS = ['heartbeat', 'calendar', 'automation'] as const
export type AmuxTriggerKind = typeof AMUX_TRIGGER_KINDS[number]

export function isAmuxTriggerKind(value: unknown): value is AmuxTriggerKind {
  return AMUX_TRIGGER_KINDS.some(kind => kind === value)
}

export function formatAmuxTriggerNote(kind: AmuxTriggerKind, note: string): string {
  return renderAmuxProtocol('trigger', 'note', { kind, note })
}

export function readAmuxTriggerNote(text: string): { kind: AmuxTriggerKind; note: string } | undefined {
  for (const kind of AMUX_TRIGGER_KINDS) {
    const header = formatAmuxTriggerNote(kind, '')
    if (text.startsWith(header)) return { kind, note: text.slice(header.length) }
  }
  return undefined
}

const FOCUS_REFERENCE_TAG = AMUX_PROTOCOL_DEFINITIONS['focus-reference'].tag
const FOCUS_READ_VIA = 'focus read --help'
const focusReference = (body: string) => renderAmuxProtocol('focus-reference', 'wire', { kind: 'focus-selection', entry: FOCUS_READ_VIA, body })
const FOCUS_REFERENCE_END = '\n</' + FOCUS_REFERENCE_TAG + '>'
const FOCUS_REFERENCE_START = focusReference('').slice(0, -FOCUS_REFERENCE_END.length)

export function formatAmuxFocusReference(body: string): string {
  return focusReference(encodeAmuxText(body))
}

/** Recognize the leading readable declaration and preserve its original bytes. */
export function readAmuxFocusReference(text: string): { raw: string; tail: string } | undefined {
  if (!text.startsWith(FOCUS_REFERENCE_START)) return
  const end = text.indexOf(FOCUS_REFERENCE_END, FOCUS_REFERENCE_START.length)
  if (end <= FOCUS_REFERENCE_START.length) return
  const body = text.slice(FOCUS_REFERENCE_START.length, end)
  if (/[<>\r]|&(?!amp;|lt;|gt;|#13;)/u.test(body)) return
  const boundary = end + FOCUS_REFERENCE_END.length
  const tail = text.slice(boundary)
  if (tail && !tail.startsWith('\n\n')) return
  return { raw: text.slice(0, boundary), tail }
}

export const AMUX_CONTINUE_MARKER = /* @__PURE__ */ renderAmuxProtocol('continue', 'wire')

export function isAmuxReactionCode(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,47}$/u.test(value)
}

/** The original Prompt owner validates and freezes the selected keyword before formatting. */
export function formatAmuxReactionMarker(code: string): string {
  return renderAmuxProtocol('reaction', 'wire', { keyword: code })
}

/** A person's confirmed answer to one Capsule page question, as delivered to the page's recipient Agent. */
export type CapsuleAnswer = { capsuleId: string; interactionId: string; question: string; answer: string }

export type AmuxProtocolDeclaration = {
  /** Absent for an unknown type: a generic reading card, not a supported business action. */
  id?: 'continue' | 'reaction' | 'capsule-answer' | 'goal-confirmation'
  tag: string
  attributes: readonly { name: string; value: string }[]
  body: string | null
  raw: string
  code?: string
  /** Read from the exact registered wire; still a declaration, not a human-source proof. */
  capsuleAnswer?: CapsuleAnswer
}
