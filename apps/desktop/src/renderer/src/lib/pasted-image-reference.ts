import { PASTED_IMAGE_EXTENSIONS } from '../../../shared/contracts'

/**
 * Recognise a token in conversation text that points at an image THIS app wrote to its own pasted
 * directory — so the renderer can show a thumbnail instead of a dead path.
 *
 * This is deliberately NOT `resolveWorkspaceRelativePath`. That function's contract is to return a
 * WORKSPACE-relative path, and a pasted image lives OUTSIDE every workspace (`<home>/.agentmux/pasted/…`);
 * routing it through there would either be rejected (its correct answer for an out-of-workspace path) or,
 * if forced, leak an absolute path all the way to `openFile`. So this is a separate, narrower judgement:
 * "is this token shaped like one of our own pasted images?" The shape (`…/.agentmux/pasted/<name>.<ext>`)
 * is app-owned, so matching on it is precise. The renderer does not know the real home, so this only
 * proves the SHAPE; the read IPC does the real confinement against the actual home and refuses anything
 * that escapes it — a spoofed look-alike therefore falls back to text rather than reading a foreign file.
 *
 * The composer writes the token with a leading `@` sigil (`appendFileReferences`). The `@` is matched but
 * not captured, so `path` is the bare absolute path the read IPC takes, while `text` keeps the verbatim
 * token (sigil included) for the plain-text fallback — the path representation is never rewritten.
 */

// Extension alternation is derived from the write-side SSOT, never re-authored, so the renderer cannot
// recognise a format the write side does not produce (or miss one it does).
const EXTENSION_ALTERNATION = PASTED_IMAGE_EXTENSIONS.join('|')
// `@?` optional sigil (outside the capture). Group 1 = an absolute path that runs through
// `/.agentmux/pasted/` and ends in a known image extension at a token boundary.
const PASTED_IMAGE_TOKEN = new RegExp(
  `@?(/[^\\s]*?/\\.agentmux/pasted/[^\\s/]+\\.(?:${EXTENSION_ALTERNATION}))(?=$|[\\s.,;:)\\]])`,
  'giu'
)

/** One piece of a text run, split around any pasted-image tokens inside it. */
export type PastedImageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; text: string; path: string }

/**
 * Split one run of text into alternating plain-text and pasted-image segments.
 *
 * Returns a single text segment when nothing matched, so a caller can keep rendering exactly what it
 * rendered before rather than special-casing the empty case.
 */
export function splitPastedImageReferences(text: string): PastedImageSegment[] {
  PASTED_IMAGE_TOKEN.lastIndex = 0
  const segments: PastedImageSegment[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = PASTED_IMAGE_TOKEN.exec(text)) !== null) {
    const path = match[1]
    if (path === undefined) continue
    if (match.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.index) })
    segments.push({ kind: 'image', text: match[0], path })
    cursor = match.index + match[0].length
  }
  if (segments.length === 0) return [{ kind: 'text', text }]
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}
