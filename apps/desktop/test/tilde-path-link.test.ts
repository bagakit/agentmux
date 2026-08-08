import { describe, expect, it } from 'vitest'
import {
  detectTerminalPathLinks,
  resolveWorkspaceRelativePath
} from '../src/renderer/src/lib/terminal-path-link.js'
import {
  classifyMarkdownLinkHref,
  splitMarkdownFileReferences
} from '../src/renderer/src/lib/markdown-file-reference.js'

// Guard for tracker #793: a `~/`-prefixed path in agent prose or terminal output must become a
// clickable file link WHEN it resolves inside the active Workspace, and must stay inert otherwise.
//
// ROOT CAUSE THIS PINS (measured, not reasoned): the token scanner already MATCHED `~/…` — its prefix
// group carries a `~\/` alternative — but `resolveWorkspaceRelativePath` returned null for every `~/`
// core with the note "no reliable home in the sandboxed renderer". So the pattern was never the
// problem; the missing piece was expanding `~` against a real host home and then applying the SAME
// within-root test an absolute path gets. These tests execute the real functions and assert the
// RESULT of that expansion, so deleting the expansion turns them red.
//
// WHY BEHAVIORAL, NOT TEXTUAL: guards in this repo that grepped source text have been defeated
// repeatedly. Every assertion here calls the shipped function and reads its return value; none reads
// source. And because `apps/desktop/tsconfig.json` includes only `src/**`, a type-level assertion
// placed in `test/` is never checked — so nothing here leans on the type system to hold the line.
//
// WHY BOTH SURFACES: `resolveWorkspaceRelativePath` is the SINGLE decision both the Terminal
// (`detectTerminalPathLinks`) and the conversation body (`splitMarkdownFileReferences` /
// `classifyMarkdownLinkHref`) route through. The delegation tests below assert the conversation
// surface answers `~/` identically, so a second, hand-copied "what counts as a path" cannot reappear
// on that side without turning red.
//
// KNOWN BLIND SPOT (stated so no one mistakes it for coverage): these tests stop at the recognizer and
// its two lib consumers. They do NOT prove the host actually threads the real home directory down to
// the render call sites (`TerminalView.tsx` and the `SessionPane → ActivityView` chain, both
// peer-held). If the host passes an empty `homeDir`, `~/` correctly stays inert (the no-home branch
// asserted below) — which is safe but means "the wiring is present" is out of this file's reach.

const HOME = '/Users/dev'
const ROOT = '/Users/dev/proj' // the Workspace lives under home — the ordinary layout

describe('tilde path recognition (#793) — the reported gap is closed', () => {
  it('recognizes a ~/ path that resolves inside the workspace and relativizes it', () => {
    // The affirmative half of the report: a `~/`-prefixed path becomes a clickable file link.
    const links = detectTerminalPathLinks('~/proj/apps/desktop/src/main.ts', ROOT, HOME)
    expect(links).toHaveLength(1)
    expect(links[0]!.path).toBe('apps/desktop/src/main.ts')
  })

  it('carries a :line:col suffix through a ~/ path', () => {
    const links = detectTerminalPathLinks('~/proj/src/index.ts:42:10', ROOT, HOME)
    expect(links).toHaveLength(1)
    expect(links[0]!).toMatchObject({ path: 'src/index.ts', line: 42, column: 10 })
  })

  it('resolves a ~/ core exactly as the expanded absolute path would', () => {
    // The direct resolver assertion — the layer the fix actually lives at.
    expect(resolveWorkspaceRelativePath('~/proj/src/x.ts', ROOT, HOME)).toBe('src/x.ts')
    // And a home carrying a trailing slash must not produce a double slash that breaks the prefix test.
    expect(resolveWorkspaceRelativePath('~/proj/src/x.ts', ROOT, '/Users/dev/')).toBe('src/x.ts')
  })
})

describe('tilde path recognition (#793) — what must stay rejected', () => {
  it('rejects a ~/ path that expands OUTSIDE the workspace — the exact reported string', () => {
    // The user's own example: `~/.claude/plugins/cache/…`. With a real home it expands to
    // `/Users/dev/.claude/…`, which is outside `/Users/dev/proj`, so it must NOT become a link —
    // exactly as `/etc/passwd` does not. A fix that expanded `~` but skipped the within-root test
    // would make this a confident-but-dead link; this asserts it stays inert.
    expect(detectTerminalPathLinks('~/.claude/plugins/cache/ponytail/4.9.0', ROOT, HOME)).toEqual([])
    expect(resolveWorkspaceRelativePath('~/.claude/plugins/cache/ponytail/4.9.0', ROOT, HOME)).toBeNull()
    expect(resolveWorkspaceRelativePath('~/notes/todo.md', ROOT, HOME)).toBeNull()
  })

  it('rejects a ~/ path when no home is known — never guesses a home', () => {
    // The host has not supplied a home (empty string). Guessing one would open the wrong file, so the
    // link stays inert — the same posture an absolute path takes when there is no workspace root.
    expect(detectTerminalPathLinks('~/proj/src/x.ts', ROOT, '')).toEqual([])
    expect(detectTerminalPathLinks('~/proj/src/x.ts', ROOT)).toEqual([]) // default arg == no home
    expect(resolveWorkspaceRelativePath('~/proj/src/x.ts', ROOT)).toBeNull()
  })

  it('does not treat ~user/ as the home directory', () => {
    // `~user/…` names a DIFFERENT user's home, which is not `homeDir`. It must never be silently
    // mapped onto our home. The scanner does not match it at all, so it yields no link even with a
    // home present — and the resolver, handed the literal core, does not expand it either.
    expect(detectTerminalPathLinks('~alice/secrets/key.pem', ROOT, HOME)).toEqual([])
    // Handed to the resolver directly, `~alice/...` is not a `~/` core, so it is treated as a literal
    // relative segment (which the workspace-confined open path then refuses) — it is NOT expanded to
    // our home. The point of this assertion: the output is not `secrets/key.pem` under HOME.
    expect(resolveWorkspaceRelativePath('~alice/secrets/key.pem', ROOT, HOME)).toBe('~alice/secrets/key.pem')
  })

  it('does not resurrect the #78 timestamp-as-file-link regression', () => {
    // `17:4` once parsed as { path: '17', line: 4 }. Widening the pattern to reach `~/` must not
    // reopen that hole: an all-digit core with a `:n` suffix is a clock, not a file. Asserted with a
    // home present, since that is the new code path.
    expect(detectTerminalPathLinks('17:4', ROOT, HOME)).toEqual([])
    expect(detectTerminalPathLinks('17:04:03', ROOT, HOME)).toEqual([])
    expect(detectTerminalPathLinks('started 14:03:07 and ended 17:04:03', ROOT, HOME)).toEqual([])
    // And a real path standing next to a clock still links — the clock is dropped without eating it.
    const links = detectTerminalPathLinks('17:04:03  error in ~/proj/src/foo.ts:12', ROOT, HOME)
    expect(links).toHaveLength(1)
    expect(links[0]!).toMatchObject({ path: 'src/foo.ts', line: 12 })
  })
})

describe('tilde path recognition (#793) — one shared decision across both surfaces', () => {
  it('the conversation body recognizes an in-workspace ~/ path through the SAME resolver', () => {
    // If a second copy of "what counts as a path" appeared on the markdown side, it would not honor
    // the home expansion and this would stay a plain-text segment. Executing the real splitter proves
    // the delegation holds.
    const segments = splitMarkdownFileReferences('I edited ~/proj/src/app.ts earlier', ROOT, HOME)
    expect(segments).toContainEqual(
      expect.objectContaining({ kind: 'file', reference: expect.objectContaining({ path: 'src/app.ts' }) })
    )
  })

  it('the conversation body leaves an out-of-workspace ~/ path as plain text', () => {
    const segments = splitMarkdownFileReferences('see ~/.ssh/config for details', ROOT, HOME)
    expect(segments.every((segment) => segment.kind === 'text')).toBe(true)
  })

  it('a markdown [label](~/…) href inside the workspace routes to the file seam', () => {
    expect(classifyMarkdownLinkHref('~/proj/src/parse.ts', ROOT, HOME)).toMatchObject({ path: 'src/parse.ts' })
    // …and one outside the workspace is refused, same as an absolute outside path.
    expect(classifyMarkdownLinkHref('~/.ssh/config', ROOT, HOME)).toBeNull()
  })
})
