import { parseAmuxObjectLink } from '@agentmux/core/sharing'
import type { ObjectLinkReference } from '../platform.js'

/** Core alone interprets the URI; a label never supplies or replaces its identity. */
export function objectLinkReference(uri: string, label?: string): ObjectLinkReference | null {
  try {
    const target = parseAmuxObjectLink(uri)
    return { uri, target, ...(label ? { label } : {}) }
  } catch { return null }
}

type Segment = { kind: 'text'; text: string } | { kind: 'object'; text: string; reference: ObjectLinkReference }

/** Bare canonical URIs are ASCII (other identity characters are encoded by Core).
 * Do not trim URI punctuation to guess a different SID; explicit Markdown disambiguates prose. */
export function splitObjectLinkReferences(text: string): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  for (const match of text.matchAll(/(?<![A-Za-z0-9_:/?&=%#.@-])amux:\/\/[^\s<>"`\[\]{}\u0080-\uffff]+/gu)) {
    const reference = objectLinkReference(match[0])
    if (!reference) continue
    if (match.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.index) })
    segments.push({ kind: 'object', text: match[0], reference })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length || !segments.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}
