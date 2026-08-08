/**
 * Detector 2 — a commit message's line anchors must come from the committed tree,
 * not the dirty working tree; and hand-authored line anchors are banned outright.
 *
 * ## What this judges
 *
 * This repo has a *verified, actively-enforced* convention: navigation anchors in
 * commit messages (and code comments) must be **symbol names, never line numbers**,
 * because line numbers rot the moment the file is edited. Ground truth: commit
 * `4ffb808` fixes a rotted anchor `union-membership-ssot.test.ts(75,3)` by replacing
 * it with the symbol `DEGRADED_REASON_ANCHOR`, writing verbatim "行号锚点会腐烂，一律用
 * 符号名" (line anchors rot, always use symbol names). A separate sibling commit shipped
 * a hand-authored `types.ts:529` prose anchor — the exact defect this detector flags.
 *
 * The recurring failure this exists to stop (documented 8+ times): a number/anchor in
 * a message is read off the DIRTY working tree, e.g. a message says `path:745` while the
 * *committed* content of that file only reaches line 728. The anchor points at a line
 * that does not exist in the tree the commit actually recorded.
 *
 * ## Shape decision (stated deliberately, per the mandate)
 *
 * Two layers, both honest:
 *
 *   Layer A — `findMessageAnchors` / `bannedProseAnchors` (pure, offline, cheap).
 *     Cheapest directly-enforceable signal: flag `path.ext:NNN` and `path.ext(NN,NN)`
 *     patterns in a message body. The one legitimate carrier of a line:col coordinate is
 *     a *pasted compiler/linter diagnostic* (`path(51,7): error TS2741`) or a stack frame
 *     (`at path:51:7`): those are reproducible evidence, not durable navigation claims, and
 *     the repo accepts them. So the discriminator is: an anchor followed by `: error` /
 *     `: warning`, or preceded by `at `, is EVIDENCE (allowed); every other line anchor is a
 *     hand-authored PROSE anchor (banned). The discriminator is the load-bearing crux and is
 *     质询'd from both sides in the self-check (a bare anchor MUST flag; a tsc diagnostic MUST
 *     stay clean — the reverse self-cert, mirroring package-report-preflight's paired门).
 *
 *   Layer B — `anchorResolvesInTree` (pure; git injected). For any anchor that survives as a
 *     real file+line reference, verify the line is within the committed file's length. A line
 *     beyond EOF is the dirty-tree-overshoot defect (`745` vs committed `728`). The file's
 *     content is read from THAT COMMIT'S tree (`git show <sha>:<path>`), never the working
 *     tree — that is the whole point of "provenance from committed content".
 *
 * ## What this CANNOT do (declared blind spots)
 *
 *   - It does NOT verify test-count numbers ("13 passed", "1066 passed | 2 failed") against
 *     reality: you cannot know what a suite count *should* be without running the suite, which
 *     is not a unit test. That provenance is only checkable by re-running (Detector 1's strong
 *     judge territory). Do not read this detector's green as "the counts are right".
 *   - Layer B checks a line is *in range*, not that it points at the *claimed symbol*: the ban
 *     means well-formed messages carry no durable line anchor to resolve a symbol against, so
 *     there is usually nothing to symbol-match. Range-overshoot is the concrete recurring bug.
 *   - The prose/evidence discriminator is textual. A message that pastes a diagnostic-shaped
 *     string it never actually ran would pass Layer A (it looks like evidence). That is a
 *     provenance claim Layer B partially backstops (the file+line must at least exist in-tree).
 *   - KNOWN BEHAVIOR (not a bug): a message that QUOTES a rotted anchor while narrating its own
 *     removal is still flagged — e.g. 4ffb808 writes "the tsc anchor said `x.test.ts(75,3)`" as
 *     it replaces that anchor with the symbol `DEGRADED_REASON_ANCHOR`. The convention's cure is
 *     to reference such an anchor BY SYMBOL, not by reproducing the coordinate in prose; the
 *     reproduced coordinate is exactly the pattern that rots and that a reader might navigate to.
 *     So this detector is deliberately pedantic here rather than carrying a fragile "quoted-and-
 *     discussed" exception (memory: forbidden-list-guard-always-leaks).
 *
 * No TypeScript SSOT is duplicated here (this is standalone git tooling), so no cross-file
 * constant guard is needed — see Detector 1's header for the .mjs/tsc duplication rule.
 */

/** File extensions that make a `word.ext` token a code reference worth anchor-checking. */
export const ANCHOR_CODE_EXTENSIONS = [
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'js',
  'jsx',
  'css',
  'json',
  'md'
]

const EXT_ALTERNATION = ANCHOR_CODE_EXTENSIONS.join('|')

// A path token ending in a code extension, immediately followed by either
//   :NNN(:NNN)?      — colon line (optionally colon col), or
//   (NNN,NNN)        — tsc paren (line,col).
const ANCHOR_RE = new RegExp(
  `([\\w./-]*[\\w-]\\.(?:${EXT_ALTERNATION}))(?::(\\d+)(?::(\\d+))?|\\((\\d+),(\\d+)\\))`,
  'g'
)

/**
 * Classify one anchor as pasted EVIDENCE (allowed) vs hand-authored PROSE (banned).
 *
 * Evidence carriers, both reproducible and thus tolerated by the repo:
 *   - a compiler/linter diagnostic: the anchor is followed by `: error` or `: warning`
 *     (optionally after the closing paren), e.g. `session-timeline.ts(51,7): error TS2741`.
 *   - a stack frame: the anchor is preceded by `at ` (Node/V8 traces), e.g. `at foo.js:51:7`.
 *
 * Everything else is a prose navigation anchor — the kind that rots and is banned.
 */
function anchorKind(text, matchStart, matchEnd) {
  // Diagnostic severity keyword may follow the anchor after an optional close-paren, an
  // optional colon, and any whitespace INCLUDING a wrapped newline+indent. Real repo example
  // (dcaa46d): `src/agent-session-store.ts(711,7)\n  error TS2741: …` — the `error` wrapped to
  // the next line, so a same-line-only check would misfire and flag legitimate pasted evidence.
  const trailing = text.slice(matchEnd, matchEnd + 48)
  if (/^\)?\s*:?\s*(error|warning)\b/i.test(trailing)) return 'diagnostic'
  // Stack-frame detection is LINE-based, not a local lookbehind: a V8 frame is
  // `at path:line:col` OR `at func (path:line:col)`, so the `at` can be far from the path.
  // The reliable signal is that the whole line begins with `at ` after indentation.
  const lineStart = text.lastIndexOf('\n', matchStart - 1) + 1
  let lineEnd = text.indexOf('\n', matchEnd)
  if (lineEnd === -1) lineEnd = text.length
  const line = text.slice(lineStart, lineEnd)
  if (/^\s*at\s/.test(line)) return 'diagnostic'
  return 'prose'
}

/**
 * Extract every line anchor in a message body, classified.
 * Returns [{ raw, path, line, col, kind, index }]. `kind` is 'prose' | 'diagnostic'.
 */
export function findMessageAnchors(text) {
  if (typeof text !== 'string') return []
  const out = []
  ANCHOR_RE.lastIndex = 0
  let m
  while ((m = ANCHOR_RE.exec(text)) !== null) {
    const [raw, path, colonLine, colonCol, parenLine, parenCol] = m
    const line = Number(colonLine ?? parenLine)
    const col = colonCol != null ? Number(colonCol) : parenCol != null ? Number(parenCol) : null
    out.push({
      raw,
      path,
      line,
      col,
      kind: anchorKind(text, m.index, m.index + raw.length),
      index: m.index
    })
  }
  return out
}

/** The banned subset: hand-authored prose line anchors. These are the violations. */
export function bannedProseAnchors(text) {
  return findMessageAnchors(text).filter((a) => a.kind === 'prose')
}

/**
 * Resolve an anchor's (possibly abbreviated) path against a commit's tree file list.
 *
 * Pasted tsc diagnostics carry the path RELATIVE to where the compiler ran, e.g.
 * `src/agent-session-store.ts` when tsc ran inside `packages/core/` — while the tree records
 * `packages/core/src/agent-session-store.ts`. So we accept an exact repo-root match, else a
 * UNIQUE suffix match (a tree path ending in `/<anchorPath>`). Ambiguous or absent → null.
 *
 * @returns the resolved repo-root path, or null if it cannot be uniquely resolved.
 */
export function resolveAnchorPath(anchorPath, treePaths) {
  if (!Array.isArray(treePaths)) return null
  if (treePaths.includes(anchorPath)) return anchorPath
  const suffix = `/${anchorPath}`
  const matches = treePaths.filter((p) => p.endsWith(suffix))
  return matches.length === 1 ? matches[0] : null
}

/**
 * Layer B: does an anchor's line exist within the committed file's length?
 *
 * @param anchor            one entry from findMessageAnchors
 * @param committedContent  the file's content IN THE COMMIT'S TREE, or null if the path is
 *                          not present in that tree (git show returned nothing).
 * @returns { ok, reason }  ok=false when the file is absent from the commit or the line
 *                          overshoots the committed length (the dirty-tree-number defect).
 */
export function anchorResolvesInTree(anchor, committedContent) {
  if (committedContent == null) {
    return { ok: false, reason: `references ${anchor.path} which is not in the commit's tree` }
  }
  // Number of addressable lines. A file with a trailing newline still has content on the
  // last non-empty line; count newlines + 1 minus a trailing-newline adjustment.
  const lines = committedContent.split('\n')
  const lineCount = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  if (anchor.line > lineCount) {
    return {
      ok: false,
      reason: `${anchor.raw} points at line ${anchor.line} but committed ${anchor.path} has only ${lineCount} lines (dirty-tree number)`
    }
  }
  return { ok: true, reason: '' }
}

// ---------------------------------------------------------------------------
// CLI: node commit-message-anchor-provenance.mjs [<commit-ish> ...]
// Defaults to HEAD. Read-only. Exit 1 if any violation is found.
// ---------------------------------------------------------------------------

async function gitLines(args) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run('git', args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/** Read a file's content from a specific commit's tree; null if it is not present there. */
async function readCommittedFile(sha, path) {
  try {
    return await gitLines(['show', `${sha}:${path}`])
  } catch {
    return null
  }
}

/** Full list of files in a commit's tree (for resolving abbreviated diagnostic paths). */
async function treePaths(sha) {
  try {
    return (await gitLines(['ls-tree', '-r', '--name-only', sha])).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function main(argv) {
  const revs = argv.length > 0 ? argv : ['HEAD']
  const shas = (await gitLines(['rev-list', '--no-walk', ...revs])).trim().split('\n').filter(Boolean)
  let violations = 0
  for (const sha of shas) {
    const message = await gitLines(['log', '-1', '--format=%B', sha])
    const short = sha.slice(0, 9)
    const files = await treePaths(sha)
    for (const anchor of bannedProseAnchors(message)) {
      violations += 1
      console.error(
        `${short}: banned prose line anchor ${anchor.raw} — use a symbol name, not a line number`
      )
    }
    for (const anchor of findMessageAnchors(message).filter((a) => a.kind === 'diagnostic')) {
      const resolved = resolveAnchorPath(anchor.path, files)
      if (resolved == null) {
        // A pasted diagnostic may reference a file this commit did not touch, or an abbreviated
        // path that is ambiguous. That is NOT the dirty-tree-number defect, so it is a note, not
        // a violation — we can only check line-range provenance for files we can resolve in-tree.
        console.log(`${short}: note — diagnostic anchor ${anchor.raw} not uniquely resolvable in tree; line-range not checked.`)
        continue
      }
      const content = await readCommittedFile(sha, resolved)
      const res = anchorResolvesInTree(anchor, content)
      if (!res.ok) {
        violations += 1
        console.error(`${short}: ${res.reason}`)
      }
    }
  }
  if (violations > 0) {
    console.error(`\n${violations} anchor violation(s) across ${shas.length} commit(s).`)
    process.exitCode = 1
  } else {
    console.log(`No banned/unresolved anchors in ${shas.length} commit(s).`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.stack ?? String(err))
    process.exitCode = 1
  })
}
