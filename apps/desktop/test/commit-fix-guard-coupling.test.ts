import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  citesMutationEvidence,
  classifyVitestOutput,
  isSourcePath,
  isTestPath,
  namedSuites,
  structuralCoupling,
  verifyCouplingLogic
} from '../scripts/commit-fix-guard-coupling.mjs'

const run = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

async function git(args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

describe('Detector 1: fix/guard same-commit coupling (Layer A structural screen)', () => {
  // ---- path classification: source vs test ------------------------------------------------

  it('classifies test paths and source paths disjointly', () => {
    expect(isTestPath('packages/core/test/client-connection-lost.test.ts')).toBe(true)
    expect(isTestPath('apps/desktop/test/foo.test.tsx')).toBe(true)
    expect(isTestPath('src/foo.spec.ts')).toBe(true)
    expect(isSourcePath('packages/core/src/client.ts')).toBe(true)
    // .tsx/.jsx MUST count as source. This is an Electron+React repo where .tsx is the DOMINANT
    // source extension (the whole renderer). If isSourcePath drops the `x?` (return /\.[cm]?[jt]s$/),
    // a .tsx-only fix with its guard left behind — the exact 3afe619 defect — slips both layers,
    // because touchesSource goes false and --verify never reverts it. Pin every renderer extension.
    expect(isSourcePath('apps/desktop/src/renderer/src/components/EditorPane.tsx'), '.tsx 不算 source——渲染层全部漏检').toBe(true)
    expect(isSourcePath('apps/desktop/src/renderer/src/main.jsx'), '.jsx 不算 source').toBe(true)
    expect(isSourcePath('apps/desktop/src/main/index.mts'), '.mts 不算 source').toBe(true)
    // A test file is NOT source, and source is NOT test — the two predicates must not overlap,
    // else a commit that touches only a test would count as "touching source" and mislead.
    expect(isSourcePath('packages/core/test/client-connection-lost.test.ts'), 'test 文件被算成 source').toBe(false)
    // A .tsx TEST file must also not count as source (disjointness holds at the dominant extension too).
    expect(isSourcePath('apps/desktop/test/surface-tool-dock.test.tsx'), '.tsx test 文件被算成 source').toBe(false)
    expect(isTestPath('packages/core/src/client.ts'), 'source 文件被算成 test').toBe(false)
    // Docs/config are neither.
    expect(isSourcePath('docs/design/x.md')).toBe(false)
    expect(isTestPath('docs/design/x.md')).toBe(false)
  })

  // ---- mutation-evidence detection: the PAIR, not a bare count ----------------------------

  it('detects a measured mutation red/green PAIR and rejects a bare suite count', () => {
    // Real repo vocabulary from 3afe619 / 4ffb808.
    expect(citesMutationEvidence('M1 删 build() 里的世代闸  1 failed | 12 passed'), 'mutation pair 没认出').toBe(true)
    expect(citesMutationEvidence('M4  3 failed | 10 passed —— 红 1/2/4')).toBe(true)
    // A bare baseline count is NOT mutation evidence — it proves no revert was measured.
    expect(citesMutationEvidence('test/x.test.ts   13 passed (13)'), 'bare 计数被误当成变异证据').toBe(false)
    expect(citesMutationEvidence('全量 npx vitest run  1066 passed | 2 failed | 3 skipped')).toBe(true)
  })

  // ---- Layer A self-check: paired must-flag / must-be-clean -------------------------------
  // The single most important pair here. The mandate: "Do not ship a detector whose only power
  // is 'a test file was also touched'." So we prove the NEGATIVE screen is the load-bearing one.

  it('FLAGS a source-only commit with no test and no mutation numbers as definitelyUncoupled', () => {
    // The 3afe619-shape accident: source fix, guard left behind, message with no measured pair.
    const paths = ['packages/core/src/client.ts', 'packages/core/src/prompt-submission.ts']
    const message = 'fix(core): readiness 等待补上界\n\n改了 handleConnectionLost。'
    const s = structuralCoupling(paths, message)
    // 前提自证: the input MUST contain source and MUST NOT contain a test — otherwise the
    // "definitelyUncoupled" verdict is meaningless.
    expect(s.touchesSource, 'fixture 里没有 source 文件——判据在空转').toBe(true)
    expect(s.touchesTest, 'fixture 意外含 test 文件').toBe(false)
    expect(s.definitelyUncoupled, '源码-only 且无变异数字却没判成 uncoupled').toBe(true)
    expect(s.screenedClean).toBe(false)
  })

  it('FLAGS a SINGLE-source-file commit too (the common case; not just multi-file)', () => {
    // Pins against gating definitelyUncoupled on sourceFiles.length >= 2. The most common fix is
    // ONE source file; if the sound negative only fires for 2+ files, the everyday single-file
    // guard-left-behind slips through. One file must be enough to flag.
    const s = structuralCoupling(['packages/core/src/client.ts'], 'fix: 一处改动，没带测试')
    expect(s.sourceFiles.length, 'fixture 不是单文件——钉不住 >=2 的门').toBe(1)
    expect(s.definitelyUncoupled, '单个源文件-only 无测试却没判 uncoupled').toBe(true)
  })

  it('does NOT scream uncoupled when a test file AND measured mutation numbers ship together', () => {
    // The 3afe619 commit as it actually landed (guard + numbers present). The screen must not
    // false-positive here — but note screenedClean is a WEAK positive, asserted as such below.
    const paths = [
      'packages/core/src/client.ts',
      'packages/core/test/client-connection-lost.test.ts'
    ]
    const message = 'fix: ...\nM1 删 build() 里的世代闸  1 failed | 12 passed'
    const s = structuralCoupling(paths, message)
    expect(s.touchesTest, 'fixture 没带上 test 文件').toBe(true)
    expect(s.hasMutationNumbers, 'fixture 消息里没有变异 pair').toBe(true)
    expect(s.definitelyUncoupled, '带了 test+变异数字却仍被判 uncoupled——假阳性').toBe(false)
  })

  it('the screen is HONESTLY WEAK: a test file with NO mutation numbers is not screened clean', () => {
    // This is the crux the mandate demands: "a test file was also touched" must NOT by itself
    // buy a pass. A source+test commit whose message cites no measured pair is NOT screenedClean.
    const paths = ['packages/core/src/client.ts', 'packages/core/test/client-connection-lost.test.ts']
    const message = 'fix: touched a test too, but measured nothing'
    const s = structuralCoupling(paths, message)
    expect(s.touchesTest).toBe(true)
    expect(s.hasMutationNumbers).toBe(false)
    expect(
      s.screenedClean,
      '仅仅"也碰了个 test 文件"就放行——这正是被禁止的假绿判据'
    ).toBe(false)
    // It is also not "definitely uncoupled" (a test IS present), so the honest verdict is
    // "inconclusive — run Layer B", which is exactly what screenedClean=false + definitelyUncoupled=false means.
    expect(s.definitelyUncoupled).toBe(false)
  })

  it('treats a pure-refactor/docs commit (no source) as nothing to screen', () => {
    const s = structuralCoupling(['docs/design/x.md', 'README.md'], 'docs: tidy')
    expect(s.touchesSource).toBe(false)
    expect(s.definitelyUncoupled, 'docs-only 不该被判 uncoupled').toBe(false)
    expect(s.screenedClean, 'docs-only 应视为无需筛查即通过').toBe(true)
  })

  // ---- suite-name parser (what Layer B re-runs) -------------------------------------------

  it('extracts the test-suite paths a message names, de-duplicated', () => {
    const message = [
      '验证（packages/core，逐条实跑）',
      '  test/client-connection-lost.test.ts        13 passed (13)',
      '  test/prompt-submission-diagnostics.test.ts 11 passed (11)',
      '  test/client-connection-lost.test.ts 又提了一次'
    ].join('\n')
    const suites = namedSuites(message)
    // 前提自证: the parser MUST find the suites, not return [] on a dead regex.
    expect(suites.length, '一个 suite 名都没解析出来——正则失效').toBe(2)
    expect(suites).toContain('test/client-connection-lost.test.ts')
    expect(suites).toContain('test/prompt-submission-diagnostics.test.ts')
  })

  it('returns [] when a message names no suites (so Layer B can refuse to report green)', () => {
    expect(namedSuites('fix: no suites mentioned here at all')).toEqual([])
  })

  // ---- Layer B: classifyVitestOutput — where every historical false report lived ----------

  it('scores `No test files found` as NOT-ran (never a green), despite exit 0', () => {
    // The measurement-hygiene trap: a misspelled suite name exits 0. It must NOT read as green.
    const v = classifyVitestOutput('filter: nope.test.ts\nNo test files found, exiting with code 1')
    expect(v.ran, 'No-test-files 被当成跑过了').toBe(false)
    expect(v.red).toBe(false)
    expect(v.reason).toContain('No test files')
  })

  it('scores a `Test Files 1 failed` as RED even when the `Tests` line reads all-passed', () => {
    // A module-scope throw prints `Test Files 1 failed` while `Tests` may read passed.
    const output = ' Test Files  1 failed (1)\n      Tests  5 passed (5)\n'
    const v = classifyVitestOutput(output)
    expect(v.red, 'Test Files failed 却没判红——只看了 Tests 行').toBe(true)
    expect(v.ran).toBe(true)
  })

  it('scores a MIXED `Test Files N failed | M passed` summary as RED (pins failed-before-passed)', () => {
    // The adversary defeat this pins: a mixed summary contains BOTH words. If the classifier
    // checks `passed` before `failed`, this partially-failing run is misread as GREEN — the
    // exact false-green class. A pure `failed (1)` fixture does NOT exercise the ordering
    // (no `passed` word), so this mixed case is the load-bearing one for the failed/passed order.
    const output = ' Test Files  1 failed | 2 passed (3)\n      Tests  4 failed | 10 passed (14)\n'
    const v = classifyVitestOutput(output)
    expect(v.red, '混合摘要里有 failed 却判成绿——passed 先判会把部分失败读成通过').toBe(true)
    expect(v.ran).toBe(true)
  })

  it('scores a clean `Test Files N passed (N)` as GREEN, ran', () => {
    const v = classifyVitestOutput(' Test Files  2 passed (2)\n      Tests  22 passed (22)\n')
    expect(v.red).toBe(false)
    expect(v.ran).toBe(true)
  })

  it('scores output with NO recognizable summary as NOT-ran (refuses to score green)', () => {
    const v = classifyVitestOutput('some npm error, process died before any summary')
    expect(v.ran, '无 summary 却被当成跑过——会把崩溃读成 green').toBe(false)
    expect(v.red).toBe(false)
  })

  // ---- Layer B: verifyCouplingLogic — the revert→run→classify brain, effects injected ------

  it('flags an UNGUARDED source when its revert keeps the named suite GREEN', async () => {
    // Simulate: reverting src/uncovered.ts changes nothing the suite checks → stays green.
    // This is the 3afe619 defect in miniature.
    const calls: string[] = []
    const effects = {
      revert: async (s: string) => { calls.push(`revert ${s}`) },
      restore: async (s: string) => { calls.push(`restore ${s}`) },
      runSuites: async () => ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n'
    }
    const result = await verifyCouplingLogic(['src/uncovered.ts'], ['x.test.ts'], effects)
    expect(result.unguarded.map((u) => u.src), '绿色 revert 没被判成 unguarded').toEqual(['src/uncovered.ts'])
    expect(result.coupled, '存在 unguarded 却仍判 coupled').toBe(false)
    // 前提自证 + 恢复保证: revert AND restore must both have run for that source.
    expect(calls, 'revert/restore 没有成对执行——恢复没跑会污染工作树').toEqual([
      'revert src/uncovered.ts',
      'restore src/uncovered.ts'
    ])
  })

  it('certifies COUPLED when every source revert turns a named suite RED', async () => {
    const effects = {
      revert: async () => {},
      restore: async () => {},
      runSuites: async () => ' Test Files  1 failed (1)\n      Tests  2 failed | 1 passed (3)\n'
    }
    const result = await verifyCouplingLogic(['src/a.ts', 'src/b.ts'], ['x.test.ts'], effects)
    expect(result.guarded).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.unguarded).toEqual([])
    expect(result.coupled, '两个 source 的 revert 都红了却没判 coupled').toBe(true)
  })

  it('treats a revert that did not actually run as INCONCLUSIVE, never guarded', async () => {
    // If the suite name is wrong, the run is No-test-files. That must not count as "guarded".
    const effects = {
      revert: async () => {},
      restore: async () => {},
      runSuites: async () => 'No test files found, exiting with code 1'
    }
    const result = await verifyCouplingLogic(['src/a.ts'], ['typo.test.ts'], effects)
    expect(result.inconclusive.map((i) => i.src), 'No-test-files 被吞成 guarded').toEqual(['src/a.ts'])
    expect(result.guarded).toEqual([])
    expect(result.coupled, 'inconclusive 存在却判了 coupled').toBe(false)
  })

  it('restores even when a suite run THROWS (finally guarantee)', async () => {
    const calls: string[] = []
    const effects = {
      revert: async (s: string) => { calls.push(`revert ${s}`) },
      restore: async (s: string) => { calls.push(`restore ${s}`) },
      runSuites: async () => { throw new Error('vitest crashed') }
    }
    await expect(verifyCouplingLogic(['src/a.ts'], ['x.test.ts'], effects)).rejects.toThrow('vitest crashed')
    expect(calls, 'run 抛异常后 restore 没跑——工作树会被留在 reverted 状态').toEqual([
      'revert src/a.ts',
      'restore src/a.ts'
    ])
  })

  // ---- Real-tree drive against the documented precedent commits ---------------------------

  it('screens the precedent commit 3afe619 from real history and confirms the scan ran', async () => {
    // 3afe619 shipped its guard (client-connection-lost.test.ts) AND measured mutations, so the
    // WEAK screen must not flag it as definitelyUncoupled. We assert the file list was actually
    // read from git (non-empty) so a broken diff-tree cannot pass this as a vacuous green.
    const paths = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', '3afe619']))
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(paths.length, '3afe619 的文件列表读成空——git 读取失败会让下面全是空转').toBeGreaterThan(0)
    const message = await git(['log', '-1', '--format=%B', '3afe619'])
    const s = structuralCoupling(paths, message)
    expect(s.touchesSource, '3afe619 应当改了 source').toBe(true)
    expect(s.touchesTest, '3afe619 应当带了 test 文件').toBe(true)
    expect(s.hasMutationNumbers, '3afe619 消息里应有 N failed | M passed').toBe(true)
    expect(s.definitelyUncoupled).toBe(false)
  })
})
