import type { AgentMuxMessageEnvelope } from './agent-global-message-queue.js'

/**
 * Readable recipient-side wrapper; envelope facts have already been validated by Core.
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
  const sender = envelope.sender.kind === 'agent-session' ? envelope.sender.agentSessionId : envelope.sender.principal
  const recipient = envelope.recipient.kind === 'agent-session'
    ? envelope.recipient.agentSessionId
    : envelope.recipient.target.kind === 'agent-session' ? envelope.recipient.target.agentSessionId : envelope.recipient.target.kind
  return `<amux from="${sender}" to="${recipient}" messageId="${envelope.messageId}">\n${envelope.body}\n</amux>`
}
