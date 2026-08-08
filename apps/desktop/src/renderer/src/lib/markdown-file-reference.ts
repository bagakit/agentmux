import { detectTerminalPathLinks, type TerminalPathLink } from './terminal-path-link'

/**
 * Which references in an agent's markdown answer point at a file in this Workspace — and where each
 * one starts and ends inside the text it was found in.
 *
 * The Activity projection and the Terminal projection show the same Agent, and an Agent that writes
 * `src/foo.ts` means the same thing in both. So the acceptance rule is NOT restated here: this module
 * calls `detectTerminalPathLinks` for every judgement about what is and is not a path. Two copies of
 * "what counts as a path" would drift on the details (bare words, `~/`, escaping the root), and the
 * drift shows up only as "this link does nothing" — a failure nobody reports.
 *
 * What this module owns is the part markdown has and a terminal line does not: an INLINE TREE. The
 * paths agents actually write are `` `src/foo.ts` `` and bare paths in a sentence, not `[](…)` — so
 * detection runs over text and code nodes, and `[label](href)` is only the third case. A pass that
 * looked at `href` alone would be nearly inert against real output.
 */

/** A reference resolved to a workspace-relative path, plus the span it occupies in its source text. */
export type MarkdownFileReference = TerminalPathLink

/** One piece of an inline node split around its file references. */
export type MarkdownInlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'file'; text: string; reference: MarkdownFileReference }

/**
 * Split one run of text into alternating plain and file-reference segments.
 *
 * Returns a single text segment when nothing matched, so a caller can keep rendering exactly what it
 * rendered before rather than special-casing the empty case.
 */
export function splitMarkdownFileReferences(
  text: string,
  workspaceRoot: string,
  homeDir = ''
): MarkdownInlineSegment[] {
  const references = detectTerminalPathLinks(text, workspaceRoot, homeDir)
  if (references.length === 0) return [{ kind: 'text', text }]
  const segments: MarkdownInlineSegment[] = []
  let cursor = 0
  for (const reference of references) {
    if (reference.index > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, reference.index) })
    }
    segments.push({
      kind: 'file',
      text: text.slice(reference.index, reference.index + reference.length),
      reference
    })
    cursor = reference.index + reference.length
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}

/**
 * Decide what a `[label](href)` link opens.
 *
 * Today every markdown link goes to `openExternal`, so `[the parser](./src/parse.ts)` is handed to the
 * system browser. A link whose href resolves inside the Workspace is a file reference; everything else
 * — including every http(s) URL — stays external, because Main owns scheme normalisation and refusal
 * and this function must not become a second place that decides what is safe to open.
 */
export function classifyMarkdownLinkHref(
  href: string,
  workspaceRoot: string,
  homeDir = ''
): MarkdownFileReference | null {
  // A scheme means the target is not a workspace path, whatever its shape. Checked before detection
  // so `file:///etc/passwd` can never be mistaken for a relative path with colons in it.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null
  const trimmed = href.trim()
  if (!trimmed) return null
  const references = detectTerminalPathLinks(trimmed, workspaceRoot, homeDir)
  // The whole href must be the path. A partial match means the href is something else that merely
  // contains a path-like run (`a b/c`), and opening that would be a guess.
  const [only] = references
  if (!only || references.length !== 1) return null
  return only.index === 0 && only.length === trimmed.length ? only : null
}

/**
 * Reveal target for a reference carrying `:line[:col]`, in the shape `openFile` takes, or undefined.
 *
 * Separate from detection because `openFile`'s third argument is optional and
 * `exactOptionalPropertyTypes` refuses `{ line: number | undefined }` where `{ line?: number }` is
 * declared — so the absent case has to be a missing argument, not a present-but-undefined one.
 */
export function referenceRevealLocation(
  reference: MarkdownFileReference
): { line: number; column?: number } | undefined {
  if (reference.line === undefined) return undefined
  return reference.column === undefined
    ? { line: reference.line }
    : { line: reference.line, column: reference.column }
}
