import { base58 } from '@scure/base'
import { AgentMuxError } from './errors.js'

/**
 * New durable Session identities: 17 Base58 characters, without 0/O/I/l or punctuation.
 * Each complete 12-byte sample retains 96 bits; left padding also fixes small/leading-zero values.
 * At 10 million Sessions the birthday collision probability is below 10^-12.
 * This module also runs in browser clients; Core and Desktop mint the same identity.
 */
function encodeAgentSessionId(bytes: Uint8Array): string {
  return base58.encode(bytes).padStart(17, '1')
}

export function mintAgentSessionId(): string {
  return encodeAgentSessionId(globalThis.crypto.getRandomValues(new Uint8Array(12)))
}

/** New operations derive the same fixed-width space; retries resolve their original durable ID first. */
export async function deriveAgentSessionId(operationId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(`agentmux.initial-session.v2:${operationId}`))
  return encodeAgentSessionId(new Uint8Array(digest).slice(0, 12))
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
