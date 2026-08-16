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
 * @param homeDir Absolute path of the host home directory, used only to expand a leading `~/` to an
 *   absolute path before the same within-root test runs. Empty string means "no home known": a `~/`
 *   path is then rejected (never underlined), exactly as an absolute path is with no root.
 */
export function detectTerminalPathLinks(
  text: string,
  workspaceRoot: string,
  homeDir = ''
): TerminalPathLink[] {
  const links: TerminalPathLink[] = []
  PATH_TOKEN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATH_TOKEN.exec(text)) !== null && links.length < MAX_LINKS_PER_LINE) {
    const rawCore = match[1]
    if (rawCore === undefined) continue
    const lineStr = match[2]
    const colStr = match[3]
    const hasSuffix = lineStr !== undefined
    // A LEADING `@` is a mention/composer sigil, not part of the path. `PATH_TOKEN` puts `@` in both
    // the lookbehind and the segment class, and the lookbehind only stops a match RESTARTING after an
    // `@` — it does not stop one STARTING at an `@`. So `@src/foo.ts` arrives here with the `@` glued
    // on and, left in place, resolves against the root as `<root>/@/…` (a path that never exists).
    // Strip only the leading `@`; a mid-segment `@` (`node_modules/@types/node/index.d.ts`) must
    // survive, and it does — there the `@` never starts a match because the preceding `/` is in the
    // lookbehind set, so it is never at `rawCore[0]`. The stripped `@` stays OUTSIDE the link span
    // (index advances past it, length shrinks) so it renders as the plain sigil it is.
    const atPrefixLength = rawCore.startsWith('@') ? 1 : 0
    // Trim trailing prose punctuation from the core. This is only reachable when there is no
    // `:line` suffix, since a suffix ends the token in digits.
    const core = rawCore.slice(atPrefixLength).replace(TRAILING_PUNCTUATION, '')
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
    const resolved = resolveWorkspaceRelativePath(core, workspaceRoot, homeDir)
    if (resolved === null) continue
    const suffix = hasSuffix ? match[0].slice(rawCore.length) : ''
    links.push({
      index: match.index + atPrefixLength,
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
 *
 * `~/` is expanded against `homeDir` FIRST, then the result runs through the very same within-root
 * test an absolute path gets — because the only thing the open pipeline can open is a path inside the
 * active Workspace (`files.read` throws "Path escapes the workspace root" for anything else). So
 * `~/proj/src/x.ts` with home `/home/dev` and root `/home/dev/proj` relativises to `src/x.ts`, while
 * `~/.claude/plugins/...` — the reported case — expands to an absolute path OUTSIDE the root and is
 * rejected, exactly as `/etc/passwd` is. Expanding then reusing the absolute branch is what keeps
 * `~/` from becoming a second, looser notion of "openable" that drifts from the absolute one.
 *
 * Three tilde shapes, decided deliberately, not collapsed together:
 *   - `~/...` → expand against `homeDir`. This is the case agents and tools actually print.
 *   - `~` alone → never reaches here: `PATH_TOKEN` requires a final path segment, so a bare `~` does
 *     not match at all. Nothing to decide.
 *   - `~user/...` → deliberately NOT treated as home, and it never even reaches this function: the
 *     scanner cannot match it. The prefix group's only tilde alternative is `~\/` (a slash must
 *     follow `~` immediately), and `~` is absent from the segment class `[\w.@+-]`, so the scan can
 *     neither begin with `~user` nor start at `user` (the lookbehind excludes a preceding `~`). A
 *     per-user home is not `homeDir`, so silently mapping `~user/` onto `homeDir` would open the
 *     wrong person's file — leaving it unmatched is the correct refusal, not an oversight.
 *
 * `homeDir` empty means "no home known" (the host has not supplied one): a `~/` path is then rejected
 * rather than guessed, the same posture absolute paths take when there is no workspace root.
 */
export function resolveWorkspaceRelativePath(
  core: string,
  workspaceRoot: string,
  homeDir = ''
): string | null {
  // `~/` is the home directory. Expand it to an absolute path, then let the absolute branch below
  // apply the identical within-root test. With no home known, reject rather than guess.
  let candidate = core
  if (core.startsWith('~/')) {
    if (!homeDir) return null
    candidate = `${homeDir.replace(/\/+$/, '')}${core.slice(1)}`
  }
  if (candidate.startsWith('/')) {
    // Absolute (including an expanded `~/`): keep it only when it lives inside the active workspace,
    // so system paths like `/usr/lib/...` — and a home path outside the workspace — never render as
    // confident-but-dead links.
    const root = workspaceRoot.replace(/\/+$/, '')
    if (!root || candidate === root || !candidate.startsWith(`${root}/`)) return null
    const relative = candidate.slice(root.length + 1)
    return relative.length > 0 ? relative : null
  }
  // Relative: strip a single leading `./`. A leading `../` escapes the root (relative paths resolve
  // against the workspace root), so reject rather than underline a link main would refuse.
  const relative = candidate.startsWith('./') ? candidate.slice(2) : candidate
  if (!relative || relative === '..' || relative.startsWith('../')) return null
  return relative
}
