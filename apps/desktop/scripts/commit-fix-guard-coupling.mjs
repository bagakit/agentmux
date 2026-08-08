/**
 * Detector 1 — a fix and its guard must ship in the SAME commit.
 *
 * ## The accident this exists to prevent
 *
 * This repo stages explicit paths (`git commit --only <paths>`) so concurrent agents'
 * in-flight edits are not swept in. The documented, repeated cost: a source fix is committed
 * while the ONLY test that would catch its regression stays behind in the working tree.
 * Ground truth — commit `3afe619`'s message claims `11/11` green, but that was a DIRTY-tree
 * number: on HEAD, with the guard absent from the tree, deleting the fix left all tests green.
 * The repo even named the convention (`#664`, cited in `4ffb808`): "修复与它唯一的判据同一
 * 提交发货" — a fix ships in the same commit as its sole criterion.
 *
 * The honest question is: **for a given commit, does every source change in it have a
 * criterion — a test that FAILS when the change is reverted — that is either in the same
 * commit or already on the parent?** The truthful answer requires a mutation run, which
 * cannot live in a unit test. So this file is deliberately split:
 *
 *   Layer A — `structuralCoupling` (pure, cheap, and WEAK — labeled as such).
 *     For a commit's file list: does it touch any test file, does it touch source files,
 *     and does its message cite a measured red/green mutation pair? This is a screening
 *     heuristic ONLY. As this repo's own record shows (see memory: "a test file was also
 *     touched" has been satisfied by luck many times), a green here proves NOTHING about
 *     whether the guard actually guards. Its sole honest use is: a source-touching commit
 *     with NO test file and NO cited mutation numbers is *definitely* uncoupled — a fast,
 *     sound NEGATIVE screen. A positive is not trusted; run Layer B.
 *
 *   Layer B — `classifyVitestOutput` + `verifyCouplingLogic` + the `--verify` CLI mode (the
 *     REAL judge; a script an agent/human runs at commit time, NOT a unit test). Given a commit
 *     SHA: for each source file, revert it to its parent content, run the suite(s) the message
 *     names, and report which reverts stay GREEN. A revert that stays green is an unguarded
 *     change — the exact 3afe619 defect. Two pieces are extracted PURE and unit-tested because
 *     they are exactly where every historical false report in this repo lived:
 *       · `classifyVitestOutput` — never trusts exit code or the `Tests` line. `No test files
 *         found` (exits 0!) is scored ran:false, a `Test Files … failed` line is red even when
 *         `Tests` reads all-passed (module-scope throw), and an unrecognizable summary is
 *         ran:false so the caller refuses to score it green.
 *       · `verifyCouplingLogic` — the revert→run→classify loop with injected effects; a revert
 *         that runs green is unguarded, a revert that did not actually run is inconclusive
 *         (never silently "guarded").
 *     The CLI reverts IN PLACE in the real repo and restores in a finally, because a fresh
 *     scratch `git worktree` has no node_modules (verified: `vitest --root <wt>` prints no
 *     Test Files line at all) and memory forbids symlinking/copying node_modules into one. It
 *     refuses to run if any file it would mutate is dirty, so it cannot clobber a peer's edit.
 *     This is why Layer B is a script, not an `it()`: it mutates the tree and runs whole suites.
 *
 * ## What Layer B CANNOT do (declared blind spots)
 *
 *   - It reverts whole file-level diffs per source file (hunk-granular revert of interleaved
 *     edits is left to the human reading the report); a commit that fixes two things in one
 *     file where only one is guarded can still pass if reverting the whole file trips the one
 *     guard. It flags per-FILE uncoupling, not per-mechanism. 3afe619's own message shows the
 *     finer discipline (M1..M6, one mechanism each) that only a human can currently drive.
 *   - It trusts the message's named suites. If the message names the wrong/narrower suite than
 *     the one that guards the change, a revert can stay green against the named suite while a
 *     real guard exists elsewhere. It reports "no named suites found" loudly rather than
 *     silently passing (the empty-scan false-green, per AGENTS.md's contract-test rule).
 *   - It mutates the real working tree (then restores). It refuses on a dirty target and runs a
 *     finally-restore, but a hard crash mid-run could leave a file reverted — the restore is
 *     `git checkout <sha> -- <src>`, re-runnable by hand. Do not run it with unsaved work.
 *   - It cannot run in this repo's own unit-test lane (needs real deps + full suite runs). The
 *     unit tests here cover Layer A, the suite-name PARSER, `classifyVitestOutput`, and the
 *     `verifyCouplingLogic` orchestration via injected effects — everything except the shell-out.
 *
 * ## .mjs / tsc duplication note (verified repo facts)
 *
 * A .mjs script cannot import a TypeScript SSOT, and `tsc` does not see .mjs. This file
 * duplicates NO TS constant — everything here is git/text logic — so no cross-file constant
 * guard is required. If a future edit introduces a shared constant, guard the duplication with
 * a test that reads both files (types cannot), per memory: constant-copies-outside-the-build-graph.
 */

/** A path is a test file if any segment is `test`/`tests` or the basename matches *.test.* / *.spec.*. */
export function isTestPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  const segments = path.split('/')
  if (segments.some((s) => s === 'test' || s === 'tests' || s === '__tests__')) return true
  const base = segments[segments.length - 1]
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)
}

/** A path is guardable SOURCE if it is a code file and not a test. Docs/config are ignored. */
export function isSourcePath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (isTestPath(path)) return false
  return /\.[cm]?[jt]sx?$/.test(path)
}

/**
 * Does a commit message cite a measured mutation red/green pair?
 *
 * Real repo vocabulary (sampled from the last 40 commits): `1 failed | 12 passed`,
 * `3 failed | 10 passed`, `2 failed | 11 passed`. The discriminator is the PAIRING —
 * a bare `13 passed` is a suite baseline, not a mutation result. We require both a
 * non-zero-capable `N failed` and an `M passed` joined by `|`, which is how every mutation
 * line in this repo's history is written.
 */
export function citesMutationEvidence(message) {
  if (typeof message !== 'string') return false
  // A pair is `N failed | M passed` OR `M passed | N failed` — real messages write both
  // orders (per-mutation lines lead with `failed`, full-suite baselines lead with `passed`).
  // The load-bearing property is the `passed`↔`failed` adjacency joined by `|`; a bare
  // `13 passed (13)` has no such pairing and must NOT count as measured mutation evidence.
  return (
    /\d+\s*failed\s*\|\s*\d+\s*passed/.test(message) ||
    /\d+\s*passed\s*\|\s*\d+\s*failed/.test(message)
  )
}

/**
 * Layer A — WEAK structural screen. See header: a NEGATIVE here is sound (uncoupled for sure);
 * a POSITIVE is not trusted. `changedPaths` is the commit's file list.
 */
export function structuralCoupling(changedPaths, message) {
  const paths = Array.isArray(changedPaths) ? changedPaths : []
  const sourceFiles = paths.filter(isSourcePath)
  const testFiles = paths.filter(isTestPath)
  const touchesSource = sourceFiles.length > 0
  const touchesTest = testFiles.length > 0
  const hasMutationNumbers = citesMutationEvidence(message)
  // Definitely uncoupled: changes source, ships no test, cites no measured mutation.
  const definitelyUncoupled = touchesSource && !touchesTest && !hasMutationNumbers
  return {
    sourceFiles,
    testFiles,
    touchesSource,
    touchesTest,
    hasMutationNumbers,
    definitelyUncoupled,
    // A positive screen is explicitly NOT a pass — it only means "not caught by the cheap net".
    screenedClean: touchesSource ? touchesTest && hasMutationNumbers : true
  }
}

/**
 * Parse the suite paths a commit message names as its verification. The repo writes suite
 * references as bare test paths, e.g. `test/client-connection-lost.test.ts   13 passed (13)`
 * or `packages/core/test/prompt-submission-diagnostics.test.ts`. We extract every token that
 * looks like a *.test.* / *.spec.* path so Layer B knows which suites to re-run.
 */
export function namedSuites(message) {
  if (typeof message !== 'string') return []
  const re = /[\w./-]*[\w-]\.(?:test|spec)\.[cm]?[jt]sx?/g
  const found = new Set()
  let m
  while ((m = re.exec(message)) !== null) found.add(m[0])
  return [...found]
}

/**
 * Classify a vitest run's output into red/green — the LOAD-BEARING piece, because every
 * historical false report in this repo lived exactly here:
 *   - `No test files found` still exits 0 (a misspelled suite name looks green).
 *   - a suite that throws at module scope prints `Test Files 1 failed` while `Tests` reads
 *     all-passed — judging by `Tests` alone (or exit code) misses it.
 * So we NEVER trust the exit code or the `Tests` line alone. Rules, in order:
 *   1. `No test files found` → not a real run. `{ red:false, ran:false }` — caller must treat
 *      this as "cannot verify", never as a green (empty-scan false-green, AGENTS.md contract rule).
 *   2. a `Test Files … failed` line → red.
 *   3. an explicit `Test Files … passed (N)` with no failed → green, ran.
 *   4. anything else (no recognizable summary) → `{ red:false, ran:false }`, reason set, so the
 *      caller refuses to score it green.
 *
 * @returns { red, ran, reason }
 */
export function classifyVitestOutput(output) {
  const text = typeof output === 'string' ? output : ''
  if (/No test files found/.test(text)) {
    return { red: false, ran: false, reason: 'No test files found — suite name likely wrong; not a real run' }
  }
  const testFilesLine = (text.match(/Test Files[^\n]*/g) ?? []).pop() ?? ''
  if (/\bfailed\b/.test(testFilesLine)) {
    return { red: true, ran: true, reason: testFilesLine.trim() }
  }
  if (/\bpassed\b/.test(testFilesLine)) {
    return { red: false, ran: true, reason: testFilesLine.trim() }
  }
  return { red: false, ran: false, reason: 'no recognizable Test Files summary — refusing to score green' }
}

/**
 * Orchestrate the revert→run→classify logic for one commit, PURE except for the injected
 * `effects`. This is Layer B's brain, unit-testable without shelling out:
 *   effects.revert(src)      — put src back to its parent content (throwaway/in-place; caller's choice)
 *   effects.runSuites(suites)— run the named suites, return raw combined output string
 *   effects.restore(src)     — put src back to the commit's content
 *
 * A revert whose run classifies GREEN (ran && !red) is UNGUARDED — the 3afe619 defect. A run
 * that did not actually run (ran===false) is reported as inconclusive, never as guarded.
 *
 * @returns { unguarded: [{src, reason}], inconclusive: [{src, reason}], guarded: [src], coupled }
 */
export async function verifyCouplingLogic(sources, suites, effects) {
  const unguarded = []
  const inconclusive = []
  const guarded = []
  for (const src of sources) {
    await effects.revert(src)
    let verdict
    try {
      const output = await effects.runSuites(suites)
      verdict = classifyVitestOutput(output)
    } finally {
      await effects.restore(src)
    }
    if (!verdict.ran) inconclusive.push({ src, reason: verdict.reason })
    else if (verdict.red) guarded.push(src)
    else unguarded.push({ src, reason: `revert kept named suites GREEN (${verdict.reason})` })
  }
  return {
    unguarded,
    inconclusive,
    guarded,
    // Coupled only if EVERY source's revert reddened a suite. Any unguarded OR inconclusive
    // source means we cannot certify coupling.
    coupled: sources.length > 0 && unguarded.length === 0 && inconclusive.length === 0
  }
}

// ---------------------------------------------------------------------------
// CLI: node commit-fix-guard-coupling.mjs [--verify] [<commit-ish>]
//   default (no --verify): Layer A structural screen of the commit (fast, sound-negative).
//   --verify: Layer B — the REAL judge. For each source file in the commit, revert it IN PLACE
//             to its parent content in the real repo, run the message's named suites (the real
//             repo resolves node_modules/dist — a fresh scratch worktree does NOT, and memory
//             forbids symlinking/copying node_modules into one), classify red/green, then RESTORE.
//             Reports which reverts stayed GREEN (unguarded — the 3afe619 defect).
//
//   WHY IN-PLACE (and its safety contract): a fresh `git worktree` has no node_modules, so
//   `vitest --root <wt>` cannot resolve deps (verified: no Test Files line at all). Honest
//   mutation testing therefore mutates the real tree and restores it. Because this touches
//   working-tree files, --verify REFUSES to run unless every source file it will mutate is
//   currently CLEAN (no staged/unstaged changes) — otherwise it would clobber a concurrent
//   agent's in-flight edit. Run it at commit time on the commit you just made, tree otherwise settled.
//   This is why Layer B is a script, not a unit test: it shells out, mutates, and runs whole suites.
// ---------------------------------------------------------------------------

async function git(args, opts = {}) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run('git', args, { maxBuffer: 128 * 1024 * 1024, ...opts })
  return stdout
}

async function changedPathsOf(sha) {
  const out = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
  return out.trim().split('\n').filter(Boolean)
}

async function screen(sha) {
  const message = await git(['log', '-1', '--format=%B', sha])
  const paths = await changedPathsOf(sha)
  const s = structuralCoupling(paths, message)
  const short = sha.slice(0, 9)
  if (s.definitelyUncoupled) {
    console.error(`${short}: UNCOUPLED — touches source (${s.sourceFiles.join(', ')}) but ships no test and cites no mutation numbers.`)
    console.error(`  This is the 3afe619 shape. Run with --verify to prove/refute, or ship the guard in this commit.`)
    process.exitCode = 1
    return
  }
  if (!s.touchesSource) {
    console.log(`${short}: no guardable source files changed (nothing for Layer A to screen).`)
    return
  }
  console.log(`${short}: passes the WEAK structural screen (test files: ${s.testFiles.length}, mutation numbers cited: ${s.hasMutationNumbers}).`)
  console.log(`  NOTE: a positive screen proves nothing. Named suites: ${namedSuites(message).join(', ') || '(none — cannot Layer-B verify)'}`)
  console.log(`  Run with --verify to actually revert each source change and confirm a suite goes red.`)
}

/** True iff `path` has NO staged or unstaged changes right now (safe to mutate-and-restore). */
async function isPathClean(path) {
  const out = await git(['status', '--porcelain', '--', path])
  return out.trim() === ''
}

async function verify(sha) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const message = await git(['log', '-1', '--format=%B', sha])
  const suites = namedSuites(message)
  const sources = (await changedPathsOf(sha)).filter(isSourcePath)
  const repoRoot = (await git(['rev-parse', '--show-toplevel'])).trim()
  const short = sha.slice(0, 9)

  if (suites.length === 0) {
    console.error(`${short}: message names NO test suites — cannot verify. (empty-scan guard: refusing to report green)`)
    process.exitCode = 1
    return
  }
  if (sources.length === 0) {
    console.log(`${short}: no source files to revert.`)
    return
  }
  // Safety: never clobber a concurrent agent's in-flight edit. Every source we will mutate
  // must currently be clean in the working tree.
  const dirty = []
  for (const src of sources) if (!(await isPathClean(src))) dirty.push(src)
  if (dirty.length > 0) {
    console.error(`${short}: refusing --verify — these files have working-tree changes and would be clobbered: ${dirty.join(', ')}`)
    console.error(`  Commit/settle them first, then re-run at a clean tree.`)
    process.exitCode = 1
    return
  }

  const effects = {
    revert: async (src) => {
      await run('git', ['checkout', `${sha}~1`, '--', src], { cwd: repoRoot }).catch(async () => {
        // File is new in this commit: removing it is the revert.
        await run('git', ['rm', '-f', '--', src], { cwd: repoRoot })
      })
    },
    runSuites: async (suiteList) => {
      const { stdout, stderr } = await run('npx', ['vitest', 'run', ...suiteList], {
        cwd: repoRoot,
        maxBuffer: 128 * 1024 * 1024
      }).catch((e) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '' }))
      return `${stdout}\n${stderr}`
    },
    restore: async (src) => {
      // Restore to the commit's exact content (works whether revert used checkout or rm).
      await run('git', ['checkout', sha, '--', src], { cwd: repoRoot }).catch(() => {})
    }
  }

  console.log(`${short}: Layer B — reverting ${sources.length} source file(s) in place, running: ${suites.join(', ')}`)
  const result = await verifyCouplingLogic(sources, suites, effects)
  for (const g of result.guarded) console.log(`  guarded: reverting ${g} turned a named suite RED.`)
  for (const u of result.unguarded) console.error(`  UNGUARDED: ${u.src} — ${u.reason}`)
  for (const i of result.inconclusive) console.error(`  INCONCLUSIVE: ${i.src} — ${i.reason}`)
  if (result.coupled) {
    console.log(`\n${short}: every source file's revert reddened a named suite. Coupled.`)
  } else {
    console.error(`\n${short}: NOT certified coupled — ${result.unguarded.length} unguarded, ${result.inconclusive.length} inconclusive.`)
    process.exitCode = 1
  }
}

async function main(argv) {
  const doVerify = argv.includes('--verify')
  const rev = argv.filter((a) => a !== '--verify')[0] ?? 'HEAD'
  const sha = (await git(['rev-parse', rev])).trim()
  if (doVerify) await verify(sha)
  else await screen(sha)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.stack ?? String(err))
    process.exitCode = 1
  })
}
