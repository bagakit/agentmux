import { base58 } from '@scure/base'
import { AgentMuxError } from './errors.js'

/**
 * New durable Session identities: 12 Base58 characters, without 0/O/I/l or punctuation.
 * Rejection sampling covers the complete 58^12 space uniformly (about 70.3 bits).
 * Padding fixes leading-zero values; overflowing samples are retried, never truncated or reduced modulo.
 * This module also runs in browser clients; Core and Desktop mint the same identity.
 */
function encodeAgentSessionId(bytes: Uint8Array): string | null {
  const id = base58.encode(bytes)
  return id.length <= 12 ? id.padStart(12, '1') : null
}

export function mintAgentSessionId(): string {
  for (;;) {
    const id = encodeAgentSessionId(globalThis.crypto.getRandomValues(new Uint8Array(9)))
    if (id !== null) return id
  }
}

/** New operations derive the same fixed-width space; retries resolve their original durable ID first. */
export async function deriveAgentSessionId(operationId: string): Promise<string> {
  for (let nonce = 0; ; nonce++) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(`agentmux.initial-session.v3:${nonce}:${operationId}`))
    const id = encodeAgentSessionId(new Uint8Array(digest).slice(0, 9))
    if (id !== null) return id
  }
}

/** Exact canonical IDs win; a prefix is usable only while it identifies one known Session. */
export function resolveAgentSessionId(selector: string, knownSessionIds: Iterable<string>): string {
  const ids = new Set(knownSessionIds)
  if (ids.has(selector)) return selector
  const matches = selector ? [...ids].filter((id) => id.startsWith(selector)) : []
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new AgentMuxError(`Agent Session prefix is ambiguous: ${selector}. Use a longer prefix or a full ID.`, 'AMBIGUOUS_AGENT_SESSION')
  }
  throw new AgentMuxError(`Unknown Agent Session: ${selector}`, 'UNKNOWN_AGENT_SESSION')
}
