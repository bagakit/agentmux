import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import {
  detectTerminalPathLinks,
  resolveWorkspaceRelativePath
} from '@agentmux/client-ui/terminal-path-link'

const ROOT = _hygiene_fixturePath("Users/dev/proj")

/** Convenience: the single link a line is expected to yield, or fail loudly. */
function onlyLink(text: string, root = ROOT) {
  const links = detectTerminalPathLinks(text, root)
  expect(links).toHaveLength(1)
  return links[0]!
}

describe('detectTerminalPathLinks — real tool output', () => {
  it('detects a bare relative path', () => {
    const link = onlyLink('src/index.ts')
    expect(link.path).toBe('src/index.ts')
    expect(link.line).toBeUndefined()
    expect(link.index).toBe(0)
    expect(link.length).toBe('src/index.ts'.length)
  })

  it('strips a leading ./ to the canonical relative path', () => {
    const link = onlyLink('./src/index.ts')
    expect(link.path).toBe('src/index.ts')
    // The underline still covers the on-screen `./src/index.ts`.
    expect(link.index).toBe(0)
    expect(link.length).toBe('./src/index.ts'.length)
  })

  it('parses a :line suffix (tsc / eslint style)', () => {
    const link = onlyLink('packages/core/src/agent.ts:42')
    expect(link.path).toBe('packages/core/src/agent.ts')
    expect(link.line).toBe(42)
    expect(link.column).toBeUndefined()
  })

  it('parses a :line:col suffix (tsc)', () => {
    const link = onlyLink('src/index.ts:42:10')
    expect(link.path).toBe('src/index.ts')
    expect(link.line).toBe(42)
    expect(link.column).toBe(10)
    expect(link.length).toBe('src/index.ts:42:10'.length)
  })

  it('detects the path token inside a tsc diagnostic line', () => {
    // `src/index.ts(42,10): error TS2304: ...` uses parens; the bare token still carries no colon
    // form, but the common tsc pretty output is `src/index.ts:42:10`. Cover the leading token here.
    const link = onlyLink('src/store.ts:1823:3 - error: openFile signature changed')
    expect(link.path).toBe('src/store.ts')
    expect(link.line).toBe(1823)
    expect(link.column).toBe(3)
  })

  it('detects the path in a rust diagnostic pointer line', () => {
    const link = onlyLink('  --> src/main.rs:10:5')
    expect(link.path).toBe('src/main.rs')
    expect(link.line).toBe(10)
    expect(link.column).toBe(5)
  })

  it('detects the quoted path in a python traceback frame', () => {
    const link = onlyLink('  File "app/routes/home.py", line 12, in handler')
    expect(link.path).toBe('app/routes/home.py')
    expect(link.line).toBe(12)
  })

  it('detects an absolute path within the workspace root and relativizes it', () => {
    const link = onlyLink(`${ROOT}/apps/desktop/src/main.ts:5:1`)
    expect(link.path).toBe('apps/desktop/src/main.ts')
    expect(link.line).toBe(5)
    expect(link.column).toBe(1)
  })

  it('trims trailing prose punctuation around a path', () => {
    expect(onlyLink('see src/index.ts.').path).toBe('src/index.ts')
    expect(onlyLink('(src/index.ts)').path).toBe('src/index.ts')
    expect(onlyLink('opened src/index.ts, then').path).toBe('src/index.ts')
  })

  it('points the underline span at the path, not the surrounding text', () => {
    const line = '  compiling packages/core/src/x.ts:7 now'
    const link = onlyLink(line)
    expect(line.slice(link.index, link.index + link.length)).toBe('packages/core/src/x.ts:7')
  })

  it('detects multiple paths on one line', () => {
    const links = detectTerminalPathLinks('mv src/a.ts src/b.ts', ROOT)
    expect(links.map((l) => l.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

/**
 * A leading `@` is the composer/mention sigil, not part of the path. `PATH_TOKEN` used to leave it
 * glued to the core (`@src/foo.ts` → `@src/foo.ts`), which then resolved against the root as the
 * never-existing `<root>/@/…` and rendered a permanently-dead link. The fix strips ONLY a leading `@`;
 * a mid-segment `@` (scoped npm packages) must survive, because removing `@` from the segment class
 * instead would sever `@types/`. These three states are the whole contract — assert all three, since a
 * fix that only satisfied the first (drop `@` from the class entirely) would be wrong yet pass it.
 */
describe('detectTerminalPathLinks — 起头的 @ 是记号不是路径字符', () => {
  it('strips a leading @ from a relative path, and the span excludes the @', () => {
    const line = '@src/foo.ts'
    const link = onlyLink(line)
    expect(link.path).toBe('src/foo.ts')
    // The underline starts AT the path, past the sigil — index advances by one, length shrinks.
    expect(link.index).toBe(1)
    expect(line.slice(link.index, link.index + link.length)).toBe('src/foo.ts')
  })

  it('sends a leading-@ absolute path down the absolute branch, so an out-of-workspace paste is rejected', () => {
    // This is the load-bearing case for the paste feature: a pasted image lands in
    // `<home>/.agentmux/pasted/…`, OUTSIDE the workspace, and its token is written `@/abs/path`. With
    // the `@` stripped the core is a real absolute path, which the within-root test correctly rejects
    // (workspace-relative detection stops claiming it, so the image renderer can take over).
    expect(detectTerminalPathLinks(("@" + _hygiene_fixturePath("Users/x/.agentmux/pasted/paste-1.png")), ROOT)).toEqual([])
    // A leading-@ absolute path that DOES live inside the root still relativises, proving the `@` only
    // routes to the absolute branch rather than being confused for a relative segment.
    const link = onlyLink(`@${ROOT}/src/x.ts`)
    expect(link.path).toBe('src/x.ts')
  })

  it('keeps a mid-segment @ intact — scoped packages must still resolve (the fix boundary)', () => {
    // `node_modules/@types/node/index.d.ts` never had the bug: the `@` is preceded by `/`, which is in
    // the lookbehind set, so it never starts a match. This asserts the fix did NOT reach into the
    // segment class and sever it — the failure mode of the wrong fix.
    const link = onlyLink('node_modules/@types/node/index.d.ts')
    expect(link.path).toBe('node_modules/@types/node/index.d.ts')
    expect(link.index).toBe(0)
  })

  it('carries a :line:col suffix through a leading-@ path without offsetting it', () => {
    // The suffix is parsed off `match[0]` by the raw-core length, so stripping the `@` must not shift
    // the line/column. `@path:12:3` → path `path`, line 12, col 3.
    const link = onlyLink('@src/foo.ts:12:3')
    expect(link.path).toBe('src/foo.ts')
    expect(link.line).toBe(12)
    expect(link.column).toBe(3)
    expect(link.index).toBe(1)
  })
})

describe('detectTerminalPathLinks — deliberate rejections', () => {
  it('rejects bare dotted words that are not paths', () => {
    for (const prose of ['e.g.', 'foo.bar', 'i.e.', 'README', 'v1.2.3', 'Node.js']) {
      expect(detectTerminalPathLinks(prose, ROOT)).toEqual([])
    }
  })

  it('rejects a bare filename with no slash and no line suffix (ls output)', () => {
    // `ls` prints bare names; underlining every dotted name would be noise. A name only becomes a
    // link when it carries a directory or a `:line` signal prose never produces.
    expect(detectTerminalPathLinks('README.md package.json tsconfig.json', ROOT)).toEqual([])
  })

  it('treats parentheses as delimiters around a root filename', () => {
    const filename = '清理-summary.md'
    const text = `清理结果 (${filename})。 (e.g.) (1.2.3) (README) other.md`
    expect(detectTerminalPathLinks(text, ROOT)).toEqual([
      { path: filename, index: text.indexOf(filename), length: filename.length }
    ])
    expect(onlyLink('src/(summary.md)').path).toBe('src/(summary.md)')
  })

  it('accepts a root-level filename with a :line suffix', () => {
    expect(detectTerminalPathLinks('README.md', ROOT)).toEqual([])
    const link = onlyLink('README.md:3:1')
    expect(link.path).toBe('README.md')
    expect(link.line).toBe(3)
  })

  it('rejects absolute system paths outside the workspace root', () => {
    expect(detectTerminalPathLinks('/usr/lib/libSystem.dylib', ROOT)).toEqual([])
    expect(detectTerminalPathLinks('/etc/hosts:5', ROOT)).toEqual([])
  })

  it('rejects ~/ paths (no reliable home in the sandboxed renderer)', () => {
    expect(detectTerminalPathLinks('~/notes/todo.md', ROOT)).toEqual([])
  })

  it('rejects relative paths that escape the root', () => {
    expect(detectTerminalPathLinks('../secrets/key.pem', ROOT)).toEqual([])
    expect(detectTerminalPathLinks('../../etc/passwd:1', ROOT)).toEqual([])
  })

  it('does not double-underline the body of an http(s) URL owned by the link addon', () => {
    // The leading lookbehind refuses to start inside a URL, so the path provider yields nothing for
    // a line that is purely a URL — the http provider owns it.
    expect(detectTerminalPathLinks('https://example.com/a/b/c.html', ROOT)).toEqual([])
    expect(detectTerminalPathLinks('see http://localhost:3000/index.ts for details', ROOT)).toEqual([])
  })

  it('rejects an absolute root with nothing after it', () => {
    expect(detectTerminalPathLinks(ROOT, ROOT)).toEqual([])
    expect(detectTerminalPathLinks(`${ROOT}/`, ROOT)).toEqual([])
  })

  it('rejects absolute paths when there is no active workspace root', () => {
    expect(detectTerminalPathLinks(_hygiene_fixturePath("Users/dev/proj/src/x.ts"), '')).toEqual([])
    // Relative detection still works with no root.
    expect(detectTerminalPathLinks('src/x.ts', '')).toHaveLength(1)
  })
})

/**
 * A `:n` suffix is the ONLY signal that promotes a slash-less core, and clocks wear it too. These
 * are the lines a timestamped transcript produces on every row, so a hole here underlines the whole
 * time gutter — it is the common case, not an edge one.
 */
describe('detectTerminalPathLinks — 时刻不是文件', () => {
  it('rejects a wall-clock reading that looks like name:line:col', () => {
    // Regression: `prior clock` used to parse as { path: '17', line: 4, column: 3 } — the ruler and
    // every turn's time gutter render exactly this shape.
    expect(detectTerminalPathLinks(_hygiene_fixtureClock(17, 4, 3), ROOT)).toEqual([])
    expect(detectTerminalPathLinks(_hygiene_fixtureClock(9, 3), ROOT)).toEqual([])
    expect(detectTerminalPathLinks(_hygiene_fixtureClock(0, 0, 0), ROOT)).toEqual([])
  })

  it('rejects clocks embedded in prose without eating the sentence', () => {
    expect(detectTerminalPathLinks(("started " + _hygiene_fixtureClock(14, 3, 7) + " and ended " + _hygiene_fixtureClock(17, 4, 3)), ROOT)).toEqual([])
  })

  it('rejects other all-digit tokens a :n suffix would promote', () => {
    // Same root cause, different shapes: a version, a date, a bare count.
    for (const notAPath of ['1.2.3:4', (_hygiene_fixtureCivil(9, 1) + ":5"), '42:7', '1.0:1:1']) {
      expect(detectTerminalPathLinks(notAPath, ROOT)).toEqual([])
    }
  })

  it('still links a real path standing next to a clock on the same line', () => {
    // The clock must be dropped WITHOUT swallowing the path that follows it: proving the rejected
    // match still advances the scanner past its own span.
    const link = onlyLink((_hygiene_fixtureClock(17, 4, 3) + "  error in src/foo.ts:12:3"))
    expect(link.path).toBe('src/foo.ts')
    expect(link.line).toBe(12)
    expect(link.column).toBe(3)
  })

  it('keeps letter-bearing cores linkable — the suffix branch is narrowed, not closed', () => {
    expect(onlyLink('README:10').path).toBe('README')
    expect(onlyLink('README.md:3:1').path).toBe('README.md')
    expect(onlyLink('a:1').path).toBe('a')
  })

  it('exempts a directory-bearing core from the letter rule', () => {
    // A `/` is already the strong signal; an all-digit path names a real place.
    expect(onlyLink('logs/2024:5').path).toBe('logs/2024')
    expect(onlyLink('1/2/3').path).toBe('1/2/3')
  })
})

describe('resolveWorkspaceRelativePath', () => {
  it('passes a relative path through unchanged', () => {
    expect(resolveWorkspaceRelativePath('src/index.ts', ROOT)).toBe('src/index.ts')
  })

  it('strips a single leading ./', () => {
    expect(resolveWorkspaceRelativePath('./src/index.ts', ROOT)).toBe('src/index.ts')
  })

  it('relativizes an absolute path within root against a root with a trailing slash', () => {
    expect(resolveWorkspaceRelativePath(_hygiene_fixturePath("Users/dev/proj/src/x.ts"), _hygiene_fixturePath("Users/dev/proj/"))).toBe('src/x.ts')
  })

  it('rejects escapes, foreign absolutes, and homes', () => {
    expect(resolveWorkspaceRelativePath('../x.ts', ROOT)).toBeNull()
    expect(resolveWorkspaceRelativePath('..', ROOT)).toBeNull()
    expect(resolveWorkspaceRelativePath(_hygiene_fixturePath("other/root/x.ts"), ROOT)).toBeNull()
    expect(resolveWorkspaceRelativePath('~/x.ts', ROOT)).toBeNull()
  })
})


describe('complete path syntax before Workspace normalization', () => {
  it.each([
    ['src/经典.ts', 'src/经典.ts'],
    ['src/(foo)/[id]/page.tsx', 'src/(foo)/[id]/page.tsx'],
    ['"src/my file.ts":12:3', 'src/my file.ts'],
    ['src/my\\ file.ts:12:3', 'src/my file.ts'],
    ['src/a//b.ts:12', 'src/a/b.ts'],
    ['src/cafe\u0301.ts:4', 'src/cafe\u0301.ts'],
    ['src/🚀.ts:4', 'src/🚀.ts'],
  ])('keeps the exact file represented by %s', (value, expected) => {
    expect(detectTerminalPathLinks(value, ROOT)).toHaveLength(1)
    expect(detectTerminalPathLinks(value, ROOT)[0]?.path).toBe(expected)
  })
  it.each(['https://example.test/a?src=nested/file.ts', 'file:///home/a/%E5%90%8D/file.ts',
    'C:\\repo\\src\\test.ts:2', 'C:/repo/src/test.ts:2', 'src/a/../../../outside.ts', 'src/x.ts:0:0', 'src/x.ts:-1', 'src/x.ts:4:8:10',
    'src/x.ts:9007199254740992', 'src/[/fake.ts'])('does not create a substitute path from %s', value => {
    expect(detectTerminalPathLinks(value, ROOT)).toEqual([])
  })
  it('keeps all exact paths on a bounded terminal line and accepts deep file paths', () => {
    const paths = Array.from({ length: 10 }, (_, n) => 'src/nested-' + n + '/file.ts')
    paths.push('src/' + 'nested-dir/'.repeat(26) + 'leaf.ts')
    expect(detectTerminalPathLinks(paths.join(' '), ROOT).map(({ path }) => path)).toEqual(paths)
  })
  it('starts after adjoining CJK prose when an explicit prefix disambiguates the file', () => {
    const text = '详见./src/test.ts:7，中文目录/src/test.ts 和 "目录./src/test.ts"'
    expect(detectTerminalPathLinks(text, ROOT)).toEqual([
      { index: 2, length: 15, path: 'src/test.ts', line: 7 },
      { index: 18, length: 16, path: '中文目录/src/test.ts' },
      { index: 37, length: 17, path: '目录./src/test.ts' },
    ])
    expect(detectTerminalPathLinks('详见~/src/test.ts', ROOT, ROOT)).toEqual([
      { index: 2, length: 13, path: 'src/test.ts' },
    ])
    expect(detectTerminalPathLinks('详见../src/test.ts', ROOT)).toEqual([])
  })
  it.each([['src/x.ts(12,3)', 12, 3], ['src/x.ts#L42', 42, undefined]])(
    'retains a recognized coordinate suffix in %s', (value, line, column) => {
      expect(detectTerminalPathLinks(value, ROOT)[0]).toMatchObject({ path: 'src/x.ts', line })
      expect(detectTerminalPathLinks(value, ROOT)[0]?.column).toBe(column)
    })
})
