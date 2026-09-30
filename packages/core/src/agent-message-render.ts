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
}

/** Parse only the complete leading reading wrapper. The original text remains the copy source.
 * Native Provider inputs and captured deliveries use this same presentation grammar. */
export function parseAgentMuxMessagePrefix(text: string): AgentMuxMessagePrefix | null {
  const header = /^\[Message from ([^\]\r\n]+)\]\r?\n([\s\S]+)$/iu.exec(text)
  if (!header || !header[2]!.trim()) return null
  const sourceLabel = header[1]!.trim()
  if (!sourceLabel) return null
  const declaredAgent = /^Agent ([^\s\[\]]+)$/iu.exec(sourceLabel)
  return { sourceLabel, declaredAgentSessionId: declaredAgent?.[1] ?? null, body: header[2]! }
}
