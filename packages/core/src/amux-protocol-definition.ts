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

export const AMUX_REFERENCE_TAG = AMUX_PROTOCOL_DEFINITIONS['focus-reference'].tag
const readEntries = {
  'focus-selection': 'focus read --help',
  'agent-context': 'agent context --help',
  'native-context': 'agent native history --help',
} as const

export type AmuxReferenceKind = keyof typeof readEntries
const referenceEnd = '\n</' + AMUX_REFERENCE_TAG + '>'
const referenceText = (kind: AmuxReferenceKind, body: string) =>
  renderAmuxProtocol('focus-reference', 'wire', { kind, entry: readEntries[kind], body })

export function formatAmuxSourceReference(kind: AmuxReferenceKind, body: string): string {
  return referenceText(kind, encodeAmuxText(body))
}

export function formatAmuxFocusReference(body: string): string {
  return formatAmuxSourceReference('focus-selection', body)
}

const referencePrefixes = (Object.keys(readEntries) as AmuxReferenceKind[]).map(kind => ({
  kind, start: referenceText(kind, '').slice(0, -referenceEnd.length)
}))

/** Recognize the exact leading readable reference and keep its original bytes. */
export function readAmuxSourceReference(text: string): { kind: AmuxReferenceKind; raw: string; tail: string } | undefined {
  const match = referencePrefixes.find(({ start }) => text.startsWith(start))
  if (!match) return
  const end = text.indexOf(referenceEnd, match.start.length)
  if (end <= match.start.length) return
  const body = text.slice(match.start.length, end)
  if (/[<>\r]|&(?!amp;|lt;|gt;|#13;)/u.test(body)) return
  const boundary = end + referenceEnd.length
  const tail = text.slice(boundary)
  if (tail && !tail.startsWith('\n\n')) return
  return { kind: match.kind, raw: text.slice(0, boundary), tail }
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
