import { AgentMuxError } from './errors.js'

/**
 * Canonical durable Session identity: 96 random bits in 16 base64url characters.
 * At 10 million Sessions the birthday collision probability is below 10^-12.
 * This module also runs in browser clients; Core and Desktop mint the same identity.
 */
export function mintAgentSessionId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12))
  return globalThis.btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_')
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
