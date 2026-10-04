import { parseAmuxObjectLink } from '@agentmux/core/sharing'
import type { AgentLinkReference } from '../platform.js'

/** Core alone interprets the URI; a label never supplies or replaces its identity. */
export function agentLinkReference(uri: string, label?: string): AgentLinkReference | null {
  try {
    const target = parseAmuxObjectLink(uri)
    return target.kind === 'agent' ? { uri, agentSessionId: target.agentSessionId, ...(label ? { label } : {}) } : null
  } catch { return null }
}

type Segment = { kind: 'text'; text: string } | { kind: 'agent'; text: string; reference: AgentLinkReference }

/** Bare canonical URIs are ASCII (other identity characters are encoded by Core).
 * Do not trim URI punctuation to guess a different SID; explicit Markdown disambiguates prose. */
export function splitAgentLinkReferences(text: string): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  for (const match of text.matchAll(/(?<![A-Za-z0-9_:/?&=%#.@-])amux:\/\/[^\s<>"`\[\]{}\u0080-\uffff]+/gu)) {
    const reference = agentLinkReference(match[0])
    if (!reference) continue
    if (match.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.index) })
    segments.push({ kind: 'agent', text: match[0], reference })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length || !segments.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}
