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
