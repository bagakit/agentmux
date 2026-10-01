import { detectTerminalPathLinks, resolveWorkspaceRelativePath, type TerminalPathLink } from './terminal-path-link'

/**
 * Which references in an agent's markdown answer point at a file in this Workspace — and where each
 * one starts and ends inside the text it was found in.
 *
 * The Activity projection and the Terminal projection show the same Agent, and an Agent that writes
 * `src/foo.ts` means the same thing in both. Plain text and code therefore use the Terminal scanner.
 * An explicit Markdown href already declares its destination: it can encode filename characters and
 * contain Unicode that would be ambiguous in bare prose. That branch decodes once and shares the
 * Terminal's workspace/home containment resolver, without widening the bare-text scanner.
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
 * A link whose href resolves inside the Workspace is a file reference. Schemes remain outside this
 * classifier; the existing HTTP-link owner decides which external links can be opened. Encoded
 * filename characters are literal after one URI decode, never a second URL or directory grammar.
 */
export function classifyMarkdownLinkHref(
  href: string,
  workspaceRoot: string,
  homeDir = '',
  sourcePath?: string
): MarkdownFileReference | null {
  const trimmed = href.trim()
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
  // Raw spaces are ambiguous prose; encoded spaces are an explicit filename. Raw query/fragment
  // syntax is not a file destination, while %23 and %3F can name real files after the single decode.
  // A percent-encoded separator must not turn one filename segment into a different directory.
  if (!trimmed || scheme.test(trimmed) || /[\s?#\\]/u.test(trimmed) || /%(?:2f|5c)/i.test(trimmed)) return null
  let decoded: string
  try { decoded = decodeURIComponent(trimmed) } catch { return null }
  if (scheme.test(decoded) || /[\u0000-\u001f\u007f-\u009f\\]/u.test(decoded)) return null

  const suffix = /:(\d+)(?::(\d+))?$/.exec(decoded)
  const core = suffix ? decoded.slice(0, suffix.index) : decoded
  if (!core || core.length > 260 || core.includes(':') ||
      (core.startsWith('~') && !core.startsWith('~/'))) return null
  // Preserve the explicit bare-filename case; an extension or directory marker identifies a file.
  if (!core.includes('/') && !/^[^/]+\.[^/.]+$/u.test(core)) return null
  let candidate: string | null = core
  if (core.startsWith('/') || core.startsWith('~/')) {
    candidate = resolveWorkspaceRelativePath(core, workspaceRoot, homeDir)
  } else if (sourcePath) {
    const directory = sourcePath.slice(0, Math.max(0, sourcePath.lastIndexOf('/')))
    candidate = `${directory}/${core}`
  }
  if (candidate === null) return null
  const segments: string[] = []
  for (const segment of candidate.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { if (!segments.length) return null; segments.pop() }
    else segments.push(segment)
  }
  const path = resolveWorkspaceRelativePath(`./${segments.join('/')}`, workspaceRoot, homeDir)
  if (path === null) return null
  return { index: 0, length: trimmed.length, path,
    ...(suffix ? { line: Number(suffix[1]) } : {}),
    ...(suffix?.[2] !== undefined ? { column: Number(suffix[2]) } : {}) }
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
