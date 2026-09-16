import { AgentMuxError } from './errors.js'

/**
 * Canonical durable Session identity: 16 base64url characters with an alphanumeric first character.
 * Rejection sampling preserves each accepted 12-byte sample; effective entropy is about 95.954 bits.
 * At 10 million Sessions the birthday collision probability is below 10^-12.
 * This module also runs in browser clients; Core and Desktop mint the same identity.
 */
export function mintAgentSessionId(): string {
  for (;;) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const id = globalThis.btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_')
    if (/^[A-Za-z0-9]/u.test(id)) return id
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
