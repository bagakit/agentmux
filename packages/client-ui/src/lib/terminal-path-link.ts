/**
 * Pure, terminal-free detection + resolution of clickable file paths in one line of terminal
 * output. This runs inside an xterm `ILinkProvider` on the render/hover hot path, so it does ONLY
 * string work — no disk, no IPC, no existence probe. Whether a path actually exists is discovered
 * lazily when the click opens it (and a miss surfaces as a visible error), never here.
 *
 * Detection is deliberately conservative: underlining ordinary prose is worse than missing a path.
 * A core can contain a `/`, carry a line suffix and at least one letter, or be a filename delimited
 * by parentheses. Unwrapped dotted words and numeric versions remain ordinary text.
 */

/** A detected path link within one line, already resolved to a canonical workspace-relative path. */
export type TerminalPathLink = {
  /** 0-based index into the scanned line string where the underlined span starts. */
  index: number
  /** Length of the underlined span, in string characters (core + any `:line:col` suffix). */
  length: number
  /** Canonical workspace-relative path ready for `openFile` (no leading `./` or `/`). */
  path: string
  /** 1-based line from a `:line` suffix, if present. */
  line?: number
  /** 1-based column from a `:line:col` suffix, if present. */
  column?: number
}

/**
 * Files that are meant to be handed to the host OS instead of opened as editor text. Keep this
 * deliberately small and explicit: a false positive sends a source file to an unrelated app, while
 * an omitted extension still remains available through the normal editor path. Matching is by the
 * final path segment and is case-insensitive so terminal output from different platforms behaves the
 * same way.
 */
const SYSTEM_ARTIFACT_EXTENSIONS = new Set([
  '.app',
  '.dmg',
  '.pkg',
  '.exe',
  '.msi',
  '.deb',
  '.rpm',
  '.appimage',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z'
])

export function isSystemArtifactPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return [...SYSTEM_ARTIFACT_EXTENSIONS].some((extension) => name.endsWith(extension))
}

/** Reserve complete URI and foreign absolute-path tokens, including unsupported ones. */
export function terminalUriTokens(text: string): { index: number; text: string }[] {
  const pattern = /(?<![a-zA-Z0-9_./%+:-])(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:(?!-?\d)|[a-zA-Z]:[\/\\]|\\\\|\/\/)[^\s<>"\x60\p{Cc}]+/gu
  return [...text.matchAll(pattern)].map(match => ({ index: match.index, text: match[0] }))
}

const NAME = String.raw`[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Extended_Pictographic}\u200c\u200d.@+%~]`
const PARENTHESIZED_FILENAME = new RegExp(String.raw`^\((` + NAME + String.raw`+\.\p{L}[\p{L}\p{N}]+)\)$`, 'u')
const SEGMENT = String.raw`(?:` + NAME + String.raw`|\\[ \t]|\(` + NAME + String.raw`+\)|\[` + NAME + String.raw`+\])+`
const LOCATION = String.raw`(?::-?\d+(?::-?\d+)?|\(-?\d+,-?\d+\)|#L-?\d+(?::-?\d+)?)`
const INLINE_EXPLICIT_PREFIX = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]+(?=(?:\.\.?|~)\/)/u
const PATH_TOKEN = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Extended_Pictographic}\u200c\u200d.\/\\%@~:+\[\]])(?:` +
  String.raw`(?<quoted>"(?:\\["\\]|[^"\r\n])+"|'[^'\r\n]+'|\x60[^\x60\r\n]+\x60)|(?<bare>@?(?:\.\.?\/|~\/|\/)?(?:` +
  SEGMENT + String.raw`\/+)*` + SEGMENT + '))(?<location>' + LOCATION + String.raw`|(?<="), line \d+)?`, 'gu')
export function terminalFileLocation(suffix: string): { line: number; column?: number } | null {
  const [line, column] = suffix.match(/-?\d+/g)?.map(Number) ?? []
  if (line === undefined || !Number.isSafeInteger(line) || line < 1 ||
      column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return null
  return { line, ...(column === undefined ? {} : { column }) }
}

export function detectTerminalPathLinks(
  text: string,
  workspaceRoot: string,
  homeDir = '',
  reserved = terminalUriTokens(text)
): TerminalPathLink[] {
  const links: TerminalPathLink[] = []
  let reservation = 0
  for (const match of text.matchAll(PATH_TOKEN)) {
    const { quoted, bare, location } = match.groups!
    const at = bare?.startsWith('@') ? 1 : 0
    const bareToken = bare?.slice(at)
    // Explicit relative and home prefixes can follow CJK prose without a space.
    // In all other bare and quoted paths CJK characters retain their file meaning.
    const prose = bareToken?.match(INLINE_EXPLICIT_PREFIX)?.[0].length ?? 0
    const visibleName = bareToken?.slice(prose)
    const bareName = location ? visibleName : visibleName?.replace(/\.+$/, '')
    const parenthesized = bareName && !at && !location ? PARENTHESIZED_FILENAME.exec(bareName)?.[1] : undefined
    const name = quoted ? quoted.slice(1, -1).replace(/\\(["'\\])/g, '$1')
      : parenthesized ?? bareName?.replace(/\\([ \t])/g, '$1')
    if (!name || name.startsWith('~') && !name.startsWith('~/') ||
        /[\p{Cc}\\]/u.test(name)) continue
    const coordinates = location === undefined ? undefined : terminalFileLocation(location)
    if (coordinates === null || !parenthesized && !name.includes('/') && (!coordinates || !/\p{L}/u.test(name))) continue
    const index = match.index + at + prose + (parenthesized ? 1 : 0)
    const length = parenthesized?.length ?? match[0].length - at - ((bareToken?.length ?? 0) - (bareName?.length ?? 0))
    while (reserved[reservation] && reserved[reservation]!.index + reserved[reservation]!.text.length <= index) reservation++
    const occupied = reserved[reservation]
    if (occupied && occupied.index < index + length) continue
    // Don't turn a malformed path into a plausible prefix with another target.
    const tail = text.slice(match.index + match[0].length)
    if (location && /^[:\p{L}\p{M}\p{N}]/u.test(tail)) continue
    if (!quoted && /^[\/\\[\](]/u.test(tail) && !/^[)\]](?:$|\s|[.,;:)\]])/u.test(tail)) continue
    const path = resolveWorkspaceRelativePath(name, workspaceRoot, homeDir)
    if (path === null) continue
    links.push({ index, length, path, ...coordinates })
  }
  return links
}

/** Decode one explicit pathname without interpreting line suffixes or encoded separators. */
export function decodeFileReferencePath(value: string): string | null {
  if (/%(?:2f|5c)/i.test(value)) return null
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return null }
  return /[\p{Cc}\\]/u.test(decoded) ? null : decoded
}

export function resolveTerminalFileUri(raw: string, workspaceRoot: string): string | null {
  if (!/^file:\/\/(?:localhost)?\//i.test(raw) || /[?#\\\p{Cc}]/u.test(raw)) return null
  const pathname = raw.replace(/^file:\/\/(?:localhost)?/i, '')
  if (pathname.startsWith('//')) return null
  const decoded = decodeFileReferencePath(pathname)
  return decoded === null ? null : resolveWorkspaceRelativePath(decoded, workspaceRoot)
}

/** Produce the lexical Workspace-relative name. Main checks real resource confinement at open. */
export function resolveWorkspaceRelativePath(core: string, workspaceRoot: string, homeDir = ''): string | null {
  let candidate = core
  if (candidate.startsWith('~/')) {
    if (!homeDir) return null
    candidate = homeDir.replace(/\/+$/, '') + candidate.slice(1)
  }
  if (candidate.startsWith('/')) {
    const prefix = workspaceRoot.replace(/\/+$/, '') + '/'
    if (!workspaceRoot.startsWith('/') || !candidate.startsWith(prefix)) return null
    candidate = candidate.slice(prefix.length)
  }
  const parts: string[] = []
  for (const part of candidate.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/') || null
}
