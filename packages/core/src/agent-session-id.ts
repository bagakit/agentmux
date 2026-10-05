import { deriveObjectId, mintObjectId } from './object-id.js'
import { AgentMuxError } from './errors.js'

/** Session identity uses the shared product allocator; it does not carry authority. */
export const mintAgentSessionId = mintObjectId

/** Keep the original v3 domain and async API; durable operation bindings still take precedence. */
export async function deriveAgentSessionId(operationId: string): Promise<string> {
  return deriveObjectId('agentmux.initial-session.v3', operationId)
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
