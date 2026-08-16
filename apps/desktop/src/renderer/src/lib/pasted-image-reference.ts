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
/**
 * The literal that makes a token ours. Scanning is driven by `indexOf` on THIS string rather than by a
 * regex that walks the whole run.
 *
 * The obvious pattern — `/[^\s]*?/\.agentmux/pasted/…` — is O(N²) on hostile input: the lazy `[^\s]*?`
 * restarts at every `/` and rescans forward to failure, so a slash-dense run with no valid token (a file
 * tree dump, a stack trace, anything an Agent can emit or fetch) costs quadratic time ON THE RENDER
 * THREAD. Measured on the real pattern: 16k→33ms, 64k→543ms, 256k→8.9s of synchronous freeze.
 *
 * Two pattern rewrites were measured and BOTH were worse (segment-wise lazy repeat: 6x slower;
 * anchor-first with a greedy prefix: 31s at 256k) — backtracking cannot be patched by re-spelling the
 * pattern. Anchoring the SCAN is what removes it: the number of starting points becomes the number of
 * times this literal actually occurs, and each one does bounded work.
 */
const PASTED_IMAGE_ANCHOR = '/.agentmux/pasted/'
/** The file-name half, applied only at a real anchor. `i` mirrors the original pattern's flag. */
const PASTED_IMAGE_TAIL = new RegExp(
  `^[^\\s/]+\\.(?:${EXTENSION_ALTERNATION})(?=$|[\\s.,;:)\\]])`,
  'iu'
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
  const segments: PastedImageSegment[] = []
  let cursor = 0
  let from = 0
  let anchor: number
  while ((anchor = text.indexOf(PASTED_IMAGE_ANCHOR, from)) !== -1) {
    const tail = PASTED_IMAGE_TAIL.exec(text.slice(anchor + PASTED_IMAGE_ANCHOR.length))
    if (!tail) {
      from = anchor + PASTED_IMAGE_ANCHOR.length
      continue
    }
    // Whitespace is the only hard left wall: it cannot appear inside the path.
    let low = anchor
    while (low > cursor && !/\s/u.test(text[low - 1]!)) low--
    if (low < cursor) low = cursor
    // The LEFTMOST `/` in [low, anchor) — a regex tries start positions left to right, so the earliest
    // viable one wins. Walking left only as far as `@` would be wrong: `@` is an ordinary character
    // inside the path for everything except a sigil directly before the start.
    let start = -1
    for (let k = low; k < anchor; k++) {
      if (text[k] === '/') { start = k; break }
    }
    if (start === -1) {
      from = anchor + PASTED_IMAGE_ANCHOR.length
      continue
    }
    const path = text.slice(start, anchor + PASTED_IMAGE_ANCHOR.length + tail[0].length)
    const sigil = start > cursor && text[start - 1] === '@'
    const whole = sigil ? `@${path}` : path
    const tokenStart = sigil ? start - 1 : start
    if (tokenStart > cursor) segments.push({ kind: 'text', text: text.slice(cursor, tokenStart) })
    segments.push({ kind: 'image', text: whole, path })
    cursor = tokenStart + whole.length
    from = cursor
  }
  if (segments.length === 0) return [{ kind: 'text', text }]
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}
