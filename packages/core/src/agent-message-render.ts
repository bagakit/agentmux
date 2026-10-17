import { DOMParser, onWarningStopParsing, type Element } from '@xmldom/xmldom'
import type { AgentMuxMessageEnvelope } from './agent-message-envelope.js'
import { composeOutboundMessage } from './agent-outbound-message.js'
import { AGENTMUX_A2A_REMINDER } from './agent-messaging-guidance.js'

/**
 * Source plus unchanged authored body. Core authorizes identity before delivery;
 * this human reading surface does not authenticate itself and carries no machine receipt.
 *
 * **Separated from `agent-global-message-queue.ts` on purpose.** The queue module imports
 * `node:crypto` / `node:fs` / `node:path` and is not renderer-safe; barrel re-exporting it into
 * the renderer bundle graph makes Vite/rollup fail on "isAbsolute is not exported by
 * __vite-browser-external" (memory: renderer-value-import-of-core-barrel-breaks-packaging).
 *
 * Keeping this pure-string render in its own module lets renderer code depend on the wrapper
 * shape via a specific import path without dragging node:* into its bundle.
 */
function attributeText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/"/gu, '&quot;')
    .replace(/\t/gu, '&#9;').replace(/\r/gu, '&#13;').replace(/\n/gu, '&#10;')
}

function reminderText(text: string): string {
  return `<reminder>${text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/\r/gu, '&#13;')}</reminder>`
}

export function renderAgentMuxMessageEnvelope(envelope: Pick<AgentMuxMessageEnvelope, 'messageId' | 'sender' | 'senderSessionId' | 'body'>): string {
  if (envelope.sender.kind === 'agent-session' && envelope.senderSessionId !== null) {
    // The authored body is opaque. Only the fixed final reminder is escaped, so
    // tags, code and even complete example envelopes inside the body stay exact.
    return `<amux:a2a from="${attributeText(envelope.senderSessionId)}" msg-id="${attributeText(envelope.messageId)}">\n${envelope.body}\n${reminderText(AGENTMUX_A2A_REMINDER)}\n</amux:a2a>`
  }
  if (envelope.sender.kind === 'external') {
    const source = [envelope.sender.actor.application.domain, envelope.sender.actor.application.appId, envelope.sender.actor.idType,
      envelope.sender.actor.userId, envelope.sender.externalConversationId].map(encodeURIComponent).join('/')
    return composeOutboundMessage({ amux: `External message from ${source}.`, user: envelope.body })
  }
  // Human input and unverified text cannot acquire an Agent sender by formatting.
  return envelope.body
}

type AgentMuxMessageReading = {
  reminder?: { raw: string; text: string }
  /** Complete input-leading declarations, preserved as original source spans. */
  declaredContexts?: readonly { raw: string }[]
}

export type AgentMuxMessagePrefix = AgentMuxMessageReading & ({
  kind: 'content'
  /** A declaration in the text, never an authenticated sender. */
  sourceLabel: string
  declaredAgentSessionId: string | null
  body: string
  declaredMessageId?: string
  packet?: AgentMuxMessagePacket
  references?: never
} | {
  kind: 'references'
  /** The referenced authors are not the author of this notification. */
  sourceLabel: ''
  declaredAgentSessionId: null
  body: ''
  declaredMessageId?: never
  packet?: never
  references: readonly AgentMuxMessageReference[]
})

export type AgentMuxMessageReference = {
  /** These remain declarations; authorization belongs to the original journal reader. */
  declaredAgentSessionId: string
  declaredMessageId: string
  readVia: 'message --skill'
  raw: string
}

export type AgentMuxMessagePacket = {
  /** All packet metadata is authored declaration, never verified identity or time. */
  profile: string
  name: string
  time: string
  parts: readonly (
    | { kind: 'text'; text: string }
    | { kind: 'citation'; from: string; reference?: string; text: string }
  )[]
}

/** Only a reading wire; the caller owns the original records and notice input identity. */
export function renderAgentMuxMessageReferences(references: readonly { senderSessionId: string; messageId: string }[], reminder?: string): string {
  if (references.length === 0) return ''
  const tag = references.length === 1 && reminder === undefined ? 'amux:a2a' : 'a2a'
  const items = references.map(reference => `<${tag} from="${attributeText(reference.senderSessionId)}" msg-id="${attributeText(reference.messageId)}" read-via="message --skill" />`)
  if (tag === 'amux:a2a') return items[0]!
  if (reminder !== undefined) items.push(reminderText(reminder))
  return `<amux>\n${items.join('\n')}\n</amux>`
}

function attributes(element: Element, required: readonly string[], optional: readonly string[] = []): boolean {
  const names = Array.from(element.attributes).map(attribute => attribute.name)
  return required.every(name => names.includes(name)) &&
    names.every(name => (required.includes(name) || optional.includes(name)) && Boolean(element.getAttribute(name)?.trim()))
}

/** Interpret the existing single packet shape. Invalid input stays authored text. */
function parsePacket(text: string): AgentMuxMessagePacket | null {
  if (!/^<bagakit-msg(?:\s|>)/u.test(text) || !text.trimEnd().endsWith('</bagakit-msg>') || /<!|<\?/u.test(text)) return null
  try {
    const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(text, 'text/xml')
    const root = document.documentElement
    if (!root || root.tagName !== 'bagakit-msg' || !attributes(root, ['type', 'name', 'time'])) return null
    if (Array.from(document.childNodes).some(node => node !== root && (node.nodeType !== 3 || node.textContent?.trim()))) return null
    const time = root.getAttribute('time')!
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(time) || !Number.isFinite(Date.parse(time)) ||
      new Date(`${time.slice(0, 19)}Z`).toISOString().slice(0, 19) !== time.slice(0, 19)) return null
    const parts: AgentMuxMessagePacket['parts'][number][] = []
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === 3) {
        parts.push({ kind: 'text', text: node.textContent ?? '' })
      } else if (node.nodeType === 1) {
        const cite = node as Element
        if (cite.tagName !== 'cite' || !attributes(cite, ['from'], ['ref']) ||
          Array.from(cite.childNodes).some(child => child.nodeType !== 3) || !cite.textContent?.trim()) return null
        const reference = cite.getAttribute('ref')
        parts.push({ kind: 'citation', from: cite.getAttribute('from')!, text: cite.textContent,
          ...(reference === null ? {} : { reference }) })
      } else return null
    }
    if (!parts.some(part => part.text.trim())) return null
    return { profile: root.getAttribute('type')!, name: root.getAttribute('name')!, time, parts }
  } catch {
    return null
  }
}

/** A reading projection only; authored declarations never become System facts. */
function parseDeclaredContexts(text: string): AgentMuxMessagePrefix | null {
  const opening = '<amux>'
  if (!text.startsWith(opening)) return null
  const declaredContexts: { raw: string }[] = []
  let start = 0
  while (text.startsWith(opening, start)) {
    // An A2A body may itself contain closing amux tags. Recognize its exact
    // terminal grammar before inspecting a text-only platform declaration.
    const a2a = parseA2aContainer(text.slice(start))
    if (a2a) return declaredContexts.length ? { ...a2a, declaredContexts } : a2a
    const closing = text.indexOf('</amux>', start + opening.length)
    if (closing < 0) return null
    const end = closing + '</amux>'.length
    const raw = text.slice(start, end)
    if (/<!|<\?/u.test(raw)) return null
    try {
      const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(raw, 'text/xml')
      const root = document.documentElement
      if (!root || root.tagName !== 'amux' || root.attributes.length !== 0 ||
        Array.from(document.childNodes).some(node => node !== root) ||
        Array.from(root.childNodes).some(node => node.nodeType !== 3)) return null
    } catch {
      return null
    }
    declaredContexts.push({ raw })
    // Newline separators join declarations; the next line's indentation is authored tail.
    const next = end + (/^(?:\r?\n)*/u.exec(text.slice(end))?.[0].length ?? 0)
    // A partly authored or unknown second declaration keeps the entire input readable.
    if (/^<amux(?:\s|>|$)/u.test(text.slice(next))) {
      if (!text.startsWith(opening, next)) return null
      start = next
    } else {
      return { kind: 'content', sourceLabel: '', declaredAgentSessionId: null, declaredContexts, body: text.slice(end) }
    }
  }
  return null
}

/** Native inputs and captured deliveries share this reading grammar; copying keeps original bytes. */
export function parseAgentMuxMessagePrefix(text: string): AgentMuxMessagePrefix | null {
  if (!text.startsWith('<amux>')) return parseSenderPrefix(text)
  const contexts = parseDeclaredContexts(text)
  if (!contexts) return null
  if (contexts.kind === 'references' || contexts.declaredMessageId !== undefined) return contexts
  // Only newline separators join a following declaration; indentation remains authored text.
  const sender = parseSenderPrefix(contexts.body.replace(/^(?:\r?\n)*/u, ''))
  return sender ? { ...contexts, ...sender } : contexts
}

function parseA2aMetadata(sender: string, messageId: string): { sender: string; messageId: string } | null {
  try {
    const metadata = new DOMParser({ onError: onWarningStopParsing }).parseFromString(`<a2a from="${sender}" msg-id="${messageId}"/>`, 'text/xml').documentElement
    if (!metadata || !attributes(metadata, ['from', 'msg-id']) || metadata.childNodes.length) return null
    const decodedSender = metadata.getAttribute('from')!, decodedMessageId = metadata.getAttribute('msg-id')!
    if (attributeText(decodedSender) !== sender || attributeText(decodedMessageId) !== messageId) return null
    return { sender: decodedSender, messageId: decodedMessageId }
  } catch { return null }
}

function parseReminder(raw: string): AgentMuxMessageReading['reminder'] | null {
  if (!raw.startsWith('<reminder>') || !raw.endsWith('</reminder>') || raw.slice('<reminder>'.length, -'</reminder>'.length).includes('<')) return null
  try {
    const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(raw, 'text/xml')
    const root = document.documentElement
    if (!root || root.tagName !== 'reminder' || root.attributes.length !== 0 ||
      Array.from(document.childNodes).some(node => node !== root) ||
      Array.from(root.childNodes).some(node => node.nodeType !== 3)) return null
    return { raw, text: root.textContent ?? '' }
  } catch { return null }
}

function parseA2a(text: string, tag: 'amux:a2a' | 'a2a' = 'amux:a2a'): AgentMuxMessagePrefix | null {
  const header = (tag === 'amux:a2a'
    ? /^<amux:a2a from="([^"\r\n]+)" msg-id="([^"\r\n]+)">\n/u
    : /^<a2a from="([^"\r\n]+)" msg-id="([^"\r\n]+)">\n/u).exec(text)
  const closing = `\n</${tag}>`
  if (!header || !text.endsWith(closing)) return null
  const boundary = text.lastIndexOf('\n<reminder>')
  if (boundary < header[0].length) return null
  const metadata = parseA2aMetadata(header[1]!, header[2]!)
  const reminder = parseReminder(text.slice(boundary + 1, -closing.length))
  if (!metadata || !reminder) return null
  const body = text.slice(header[0].length, boundary)
  const packet = parsePacket(body)
  return { kind: 'content', sourceLabel: `Agent ${metadata.sender}`, declaredAgentSessionId: metadata.sender, declaredMessageId: metadata.messageId,
    body: packet ? packet.parts.map(part => part.text).join('') : body, reminder, ...(packet ? { packet } : {}) }
}

function parseReference(text: string, tag: 'a2a' | 'amux:a2a'): AgentMuxMessageReference | null {
  const match = (tag === 'a2a'
    ? /^<a2a from="([^"\r\n]+)" msg-id="([^"\r\n]+)" read-via="message --skill" \/>$/u
    : /^<amux:a2a from="([^"\r\n]+)" msg-id="([^"\r\n]+)" read-via="message --skill" \/>$/u).exec(text)
  if (!match || match[0] !== text) return null
  const metadata = parseA2aMetadata(match[1]!, match[2]!)
  return metadata ? { declaredAgentSessionId: metadata.sender, declaredMessageId: metadata.messageId, readVia: 'message --skill', raw: text } : null
}

function referenceReading(references: readonly AgentMuxMessageReference[], reminder?: AgentMuxMessageReading['reminder']): AgentMuxMessagePrefix {
  return { kind: 'references', sourceLabel: '', declaredAgentSessionId: null, body: '', references, ...(reminder ? { reminder } : {}) }
}

function parseA2aContainer(text: string): AgentMuxMessagePrefix | null {
  const opening = '<amux>\n', closing = '\n</amux>'
  if (!text.startsWith(opening) || !text.endsWith(closing)) return null
  const content = text.slice(opening.length, -closing.length)
  const full = parseA2a(content, 'a2a')
  if (full) return full
  const boundary = content.indexOf('\n<reminder>')
  const reminder = boundary < 0 ? undefined : parseReminder(content.slice(boundary + 1))
  if (reminder === null) return null
  const rows = (boundary < 0 ? content : content.slice(0, boundary)).split('\n')
  const references: AgentMuxMessageReference[] = []
  for (const row of rows) {
    const reference = parseReference(row, 'a2a')
    if (!reference) return null
    references.push(reference)
  }
  return referenceReading(references, reminder)
}

function parseSenderPrefix(text: string): AgentMuxMessagePrefix | null {
  if (text.startsWith('<amux:a2a')) {
    const reference = parseReference(text, 'amux:a2a')
    return reference ? referenceReading([reference]) : parseA2a(text)
  }
  const packet = parsePacket(text)
  return packet ? { kind: 'content', sourceLabel: packet.name, declaredAgentSessionId: null,
    body: packet.parts.map(part => part.text).join(''), packet } : null
}
