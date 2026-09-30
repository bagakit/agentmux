import { DOMParser, onWarningStopParsing, type Element } from '@xmldom/xmldom'
import type { AgentMuxMessageEnvelope } from './agent-global-message-queue.js'

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
export function renderAgentMuxMessageEnvelope(envelope: AgentMuxMessageEnvelope): string {
  const source = envelope.sender.kind === 'agent-session' && envelope.senderSessionId !== null
    ? `Agent ${envelope.senderSessionId}`
    : 'unverified local process'
  return `[Message from ${source}]\n${envelope.body}`
}

export type AgentMuxMessagePrefix = {
  /** A declaration in the text, never an authenticated sender. */
  sourceLabel: string
  declaredAgentSessionId: string | null
  body: string
  packet?: AgentMuxMessagePacket
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

/** Native inputs and captured deliveries share this reading grammar; copying keeps original bytes. */
export function parseAgentMuxMessagePrefix(text: string): AgentMuxMessagePrefix | null {
  const header = /^\[Message from ([^\]\r\n]+)\]\r?\n([\s\S]+)$/iu.exec(text)
  const authoredBody = header?.[2] ?? text
  const packet = parsePacket(authoredBody)
  if (!header && !packet) return null
  // An incomplete/unknown packet is not a partial reading wrapper.
  if (!packet && /^<bagakit-msg(?:\s|>)/u.test(authoredBody)) return null
  if (!authoredBody.trim()) return null
  const sourceLabel = header ? header[1]!.trim() : packet!.name
  if (!sourceLabel) return null
  const declaredAgent = header ? /^Agent ([^\s\[\]]+)$/iu.exec(sourceLabel) : null
  return { sourceLabel, declaredAgentSessionId: declaredAgent?.[1] ?? null,
    body: packet ? packet.parts.map(part => part.text).join('') : authoredBody,
    ...(packet ? { packet } : {}) }
}
