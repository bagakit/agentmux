/**
 * Pure, terminal-free detection + resolution of clickable file paths in one line of terminal
 * output. This runs inside an xterm `ILinkProvider` on the render/hover hot path, so it does ONLY
 * string work — no disk, no IPC, no existence probe. Whether a path actually exists is discovered
 * lazily when the click opens it (and a miss surfaces as a visible error), never here.
 *
 * Detection is deliberately conservative: underlining ordinary prose is worse than missing a path.
 * The crux acceptance rule — a core must contain a `/`, or carry a `:line` suffix AND at least one
 * letter — drops bare dotted words (`e.g.`, `foo.bar`, `1.2.3`, `README`) and every all-digit token
 * a `:n` would otherwise promote (`17:04:03` clocks, `1.2.3:4` versions), while still catching
 * `README.md:3:1` and every real relative/absolute path. See the module test for the full
 * accept/reject corpus.
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
 * Path-token scanner.
 *   - The leading negative lookbehind anchors to a token start and, by excluding `/` and `:`,
 *     refuses to start inside a URL already owned by the http link provider, so the two providers
 *     never underline the same span.
 *   - Group 1 = path core (optional `./` `../` `~/` `/` prefix, then `seg/`* then a final `seg`).
 *   - Group 2 = line, Group 3 = column.
 */
const PATH_TOKEN = /(?<![\w./@~:-])((?:\.\.?\/|~\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]+)(?::(\d+)(?::(\d+))?)?/g

/** A path core longer than this is not a path a developer would click; bounds pathological lines. */
const MAX_CORE_LENGTH = 260
/** Cap matches per line so a pathological line cannot make the provider do unbounded work. */
const MAX_LINKS_PER_LINE = 8
/** Prose punctuation that trails a path but is not part of it: `see src/x.ts.` / `(src/x.ts)`. */
const TRAILING_PUNCTUATION = /[.,;:)\]]+$/

/**
 * Scan one line and return every clickable path link on it, resolved to a canonical
 * workspace-relative path. Purely syntactic — see the module doc comment.
 *
 * @param text The line text as read from the xterm buffer.
 * @param workspaceRoot Absolute path of the active workspace, used only for the string-only
 *   within-root test on absolute paths. Empty string means "no active root": absolute paths are
 *   then rejected (never underlined) while relative paths still resolve.
 */
export function detectTerminalPathLinks(text: string, workspaceRoot: string): TerminalPathLink[] {
  const links: TerminalPathLink[] = []
  PATH_TOKEN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATH_TOKEN.exec(text)) !== null && links.length < MAX_LINKS_PER_LINE) {
    const rawCore = match[1]
    if (rawCore === undefined) continue
    const lineStr = match[2]
    const colStr = match[3]
    const hasSuffix = lineStr !== undefined
    // Trim trailing prose punctuation from the core. This is only reachable when there is no
    // `:line` suffix, since a suffix ends the token in digits.
    const core = rawCore.replace(TRAILING_PUNCTUATION, '')
    if (!core || core.length > MAX_CORE_LENGTH) continue
    // The crux: a real path either has a directory separator or a line-number suffix. This drops
    // every bare dotted word (`e.g.`, `1.2.3`, `README`) without touching real paths.
    if (!core.includes('/') && !hasSuffix) continue
    // ...but a `:n` suffix only promotes a core that could be a FILENAME, and a core carrying no
    // letter is a number. `17:04:03` is a clock, `1.2.3:4` a version, `2026-09-01:5` a date — each
    // satisfies the suffix branch above with a bare numeric core and would underline as a file.
    // Timestamped log lines make this the common case, not an edge one. A directory-bearing core is
    // exempt: `logs/2024:5` names a real place, and the `/` is the signal.
    if (!core.includes('/') && !/[A-Za-z]/.test(core)) continue
    const resolved = resolveWorkspaceRelativePath(core, workspaceRoot)
    if (resolved === null) continue
    const suffix = hasSuffix ? match[0].slice(rawCore.length) : ''
    links.push({
      index: match.index,
      length: core.length + suffix.length,
      path: resolved,
      ...(lineStr !== undefined ? { line: Number(lineStr) } : {}),
      ...(colStr !== undefined ? { column: Number(colStr) } : {})
    })
  }
  return links
}

/**
 * Convert a matched core to the canonical workspace-relative path `openFile` expects, or `null` to
 * reject the match entirely (so it is never underlined). All pure string math against a root string
 * the caller already holds — no disk, no IPC.
 */
export function resolveWorkspaceRelativePath(core: string, workspaceRoot: string): string | null {
  // `~/` has no reliable home in the sandboxed renderer.
  if (core.startsWith('~/')) return null
  if (core.startsWith('/')) {
    // Absolute: keep it only when it lives inside the active workspace, so system paths like
    // `/usr/lib/...` never render as confident-but-dead links.
    const root = workspaceRoot.replace(/\/+$/, '')
    if (!root || core === root || !core.startsWith(`${root}/`)) return null
    const relative = core.slice(root.length + 1)
    return relative.length > 0 ? relative : null
  }
  // Relative: strip a single leading `./`. A leading `../` escapes the root (relative paths resolve
  // against the workspace root), so reject rather than underline a link main would refuse.
  const relative = core.startsWith('./') ? core.slice(2) : core
  if (!relative || relative === '..' || relative.startsWith('../')) return null
  return relative
}
