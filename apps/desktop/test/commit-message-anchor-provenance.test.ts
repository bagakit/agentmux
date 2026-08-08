import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ANCHOR_CODE_EXTENSIONS,
  anchorResolvesInTree,
  bannedProseAnchors,
  findMessageAnchors,
  resolveAnchorPath
} from '../scripts/commit-message-anchor-provenance.mjs'

const run = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

async function git(args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

describe('Detector 2: commit-message line anchor provenance', () => {
  // ---- Layer A self-check: paired must-flag / must-be-clean -------------------------------
  // Mirrors package-report-preflight's two-sided门 (#646): a detector whose only tested world
  // is "everything violates" is blind to the side it walks on every clean commit.

  it('FLAGS a hand-authored prose line anchor (the banned, rotting kind)', () => {
    // This is the exact defect 4ffb808 fixed and a sibling commit shipped: a prose `path:NNN`.
    const message = 'fix(core): 抽出 source union\n\ntypes.ts:529 的 readinessSource 早已是派生。'
    const banned = bannedProseAnchors(message)
    // 前提自证: the scan must actually FIND its target, not report clean on an empty read.
    expect(banned.length, '扫不到那条 prose 锚点——判据在为空世界背书').toBe(1)
    expect(banned[0].path).toBe('types.ts')
    expect(banned[0].line).toBe(529)
    expect(banned[0].kind).toBe('prose')
  })

  it('also flags the tsc-paren prose form path.ts(NN,NN) when NOT a diagnostic', () => {
    // 4ffb808's own rotted anchor shape: `union-membership-ssot.test.ts(75,3)` in prose.
    const message = '第 4 条的 tsc 锚点写着 union-membership-ssot.test.ts(75,3)，随文件编辑漂走了。'
    const banned = bannedProseAnchors(message)
    expect(banned.length, '(NN,NN) 形式的 prose 锚点漏检').toBe(1)
    expect(banned[0].path).toBe('union-membership-ssot.test.ts')
    expect(banned[0].line).toBe(75)
    expect(banned[0].col).toBe(3)
  })

  it('does NOT flag a pasted compiler diagnostic (reproducible evidence is allowed)', () => {
    // The reverse self-cert (memory: package-report-preflight 的「候选其实齐全」那一侧).
    // A real tsc diagnostic carries a line:col but is evidence, not a durable nav claim.
    const message =
      '变异证明：src/session-timeline.ts(51,7): error TS2741: Property mcp is missing.'
    const all = findMessageAnchors(message)
    // 前提自证: the anchor IS present in the text — we are testing the classifier, not absence.
    expect(all.length, '连锚点都没扫到，下面的 clean 断言毫无意义').toBe(1)
    expect(all[0].kind, 'tsc 诊断被误判成 prose——会把合法证据打成违规').toBe('diagnostic')
    expect(bannedProseAnchors(message), 'diagnostic 不该进 banned 集').toEqual([])
  })

  it('does NOT flag a stack-frame anchor (`at path:NN:NN`)', () => {
    const message = 'repro trace:\n    at packages/core/src/client.ts:51:7\n    at run (x.js:9:1)'
    const all = findMessageAnchors(message)
    expect(all.length, 'stack frame 锚点没扫到').toBeGreaterThan(0)
    expect(all.every((a) => a.kind === 'diagnostic'), 'stack frame 被当成 prose').toBe(true)
    expect(bannedProseAnchors(message)).toEqual([])
  })

  it('does NOT flag a WRAPPED compiler diagnostic where `error` fell to the next line', () => {
    // Real repo shape (dcaa46d): `src/agent-session-store.ts(711,7)\n  error TS2741: …`.
    // The severity keyword wrapped to the next line; a same-line-only check false-flags it as
    // a prose violation. This pins that the classifier follows the wrap.
    const message =
      '- 往 union 加 mcp-resume 不加表键 → src/agent-session-store.ts(711,7)\n  error TS2741: Property missing.'
    const all = findMessageAnchors(message)
    expect(all.length, '连锚点都没扫到').toBe(1)
    expect(all[0].kind, '换行后的 tsc 诊断被误判成 prose——会把合法证据打成违规').toBe('diagnostic')
    expect(bannedProseAnchors(message)).toEqual([])
  })

  it('is clean on a well-formed message that uses symbol names (no line anchors at all)', () => {
    const message =
      'fix(core): 补 TERMINAL_COMPOSER_READY_TIMEOUT_MS，改 handleConnectionLost 里的 discardAll()'
    expect(findMessageAnchors(message), '符号名消息里冒出了行号锚点').toEqual([])
    expect(bannedProseAnchors(message)).toEqual([])
  })

  // ---- Layer B self-check: line must be in the committed tree, not overshoot --------------

  it('FLAGS an anchor whose line overshoots the committed file length (dirty-tree number)', () => {
    // The recurring `745` vs committed `728` defect, in the exact form Layer B receives it.
    const committed = Array.from({ length: 728 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const anchor = { raw: 'x.ts:745', path: 'x.ts', line: 745, col: null, kind: 'diagnostic', index: 0 }
    const res = anchorResolvesInTree(anchor, committed)
    expect(res.ok, '745 > 728 却判成可解析——脏树数字漏网').toBe(false)
    expect(res.reason).toContain('728')
  })

  it('is clean when the anchor line is within the committed file length', () => {
    const committed = Array.from({ length: 728 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const anchor = { raw: 'x.ts:529', path: 'x.ts', line: 529, col: null, kind: 'diagnostic', index: 0 }
    expect(anchorResolvesInTree(anchor, committed).ok, '529 <= 728 却判成越界').toBe(true)
  })

  it('FLAGS an anchor whose path is absent from the commit tree (null content)', () => {
    const anchor = { raw: 'ghost.ts:3', path: 'ghost.ts', line: 3, col: null, kind: 'diagnostic', index: 0 }
    const res = anchorResolvesInTree(anchor, null)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('not in the commit')
  })

  it('exposes a non-empty, sane extension list (guards accidental emptying of the regex)', () => {
    expect(ANCHOR_CODE_EXTENSIONS.length).toBeGreaterThan(0)
    expect(ANCHOR_CODE_EXTENSIONS).toContain('ts')
    expect(ANCHOR_CODE_EXTENSIONS).toContain('tsx')
  })

  it('resolves an abbreviated diagnostic path against the tree by unique suffix', () => {
    // Pasted tsc paths are relative to where tsc ran (`src/x.ts`), the tree records the full
    // repo-root path (`packages/core/src/x.ts`). Exact wins; else a UNIQUE suffix match.
    const tree = ['packages/core/src/agent-session-store.ts', 'apps/desktop/src/store.ts']
    expect(resolveAnchorPath('src/agent-session-store.ts', tree)).toBe('packages/core/src/agent-session-store.ts')
    expect(resolveAnchorPath('packages/core/src/agent-session-store.ts', tree)).toBe('packages/core/src/agent-session-store.ts')
    // Absent → null (so the CLI treats it as a non-fatal note, not the dirty-tree defect).
    expect(resolveAnchorPath('src/ghost.ts', tree)).toBe(null)
  })

  it('refuses to resolve an AMBIGUOUS suffix (two tree files end the same way)', () => {
    const tree = ['packages/core/src/index.ts', 'apps/desktop/src/index.ts']
    expect(resolveAnchorPath('src/index.ts', tree), '两个同后缀却选了一个——歧义应返回 null').toBe(null)
  })

  // ---- Real-tree drive: the ban is REAL, and this detector reads actual history -----------

  it('runs against the last 30 real commits and asserts the scan actually executed', async () => {
    const shas = (await git(['rev-list', '--max-count=30', 'HEAD'])).trim().split('\n').filter(Boolean)
    // 前提自证 (AGENTS.md 契约测试第三种白绿: 扫到空内容): there MUST be commits to scan.
    expect(shas.length, 'rev-list 返回空——没有历史可扫，下面的断言全是空转').toBeGreaterThan(0)
    let anchorsSeen = 0
    for (const sha of shas) {
      const message = await git(['log', '-1', '--format=%B', sha])
      anchorsSeen += findMessageAnchors(message).length
    }
    // The point of this assertion: the classifier ran over real messages (which DO contain
    // tsc-diagnostic anchors), proving the scan found real targets rather than a dead regex.
    expect(anchorsSeen, '30 条真实历史里一个锚点都没扫到——正则可能已失效').toBeGreaterThan(0)
  })
})
