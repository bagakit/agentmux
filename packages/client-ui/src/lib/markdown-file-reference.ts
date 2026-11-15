import { decodeFileReferencePath, detectTerminalPathLinks, resolveWorkspaceRelativePath, terminalFileLocation, type TerminalPathLink, type TerminalPathResolver } from './terminal-path-link.js'

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
  sourcePath?: string,
  resolvePath?: TerminalPathResolver
): MarkdownFileReference | null {
  const trimmed = href.trim()
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
  const suffix = /:(\d+)(?::(\d+))?$/.exec(trimmed)
  const pathText = suffix ? trimmed.slice(0, suffix.index) : trimmed
  // Only an explicit filename may have a colon-location suffix; arbitrary schemes remain inert.
  if (!trimmed || /[\s?#\\]/u.test(trimmed) || scheme.test(pathText) ||
      scheme.test(trimmed) && !(suffix && /\.[^./]+$/u.test(pathText))) return null
  const coordinates = suffix ? terminalFileLocation(suffix[0]) : undefined
  const core = decodeFileReferencePath(pathText)
  if (coordinates === null || !core || scheme.test(core) ||
      (core.startsWith('~') && !core.startsWith('~/'))) return null
  if (!core.includes('/') && !/^[^/]+\.[^/.]+$/u.test(core)) return null
  const slash = sourcePath?.lastIndexOf('/') ?? -1
  const candidate = core.startsWith('/') || core.startsWith('~/') || slash < 0
    ? core : sourcePath!.slice(0, slash + 1) + core
  const path = resolvePath ? resolvePath(candidate) : resolveWorkspaceRelativePath(candidate, workspaceRoot, homeDir)
  return path === null ? null : { index: 0, length: trimmed.length, ...(typeof path === 'string' ? { path } : path), ...coordinates }
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
