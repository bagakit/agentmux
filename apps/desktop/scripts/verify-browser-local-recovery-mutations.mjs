import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/main/browser-local-recovery.ts'
const dispatch = 'apps/desktop/src/main/browser-page-dispatch.ts'
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const assets = 'apps/desktop/src/main/browser-task-assets.ts'
const tests = ['apps/desktop/test/browser-local-recovery.test.tsx', 'apps/desktop/test/browser-page-dispatch.test.ts',
  'apps/desktop/test/browser-local-recovery-manager.test.ts']
const mutations = [
  { label: 'explicit-denials-retried', file: owner,
    before: "(fact.kind === 'locator-changed' || fact.kind === 'navigation-failed')",
    after: "(fact.kind !== 'navigation-failed' || fact.kind === 'navigation-failed')" },
  { label: 'user-error-lookalike-grants-authority', file: owner,
    before: 'input.failure instanceof BrowserLocalRecoveryFailure ? input.failure.fact : null',
    after: '(input.failure as BrowserLocalRecoveryFailure)?.fact ?? null' },
  { label: 'attempt-budget-exceeded', file: owner,
    before: 'number <= BROWSER_LOCAL_RECOVERY_BUDGET.attempts', after: 'number <= BROWSER_LOCAL_RECOVERY_BUDGET.attempts + 1' },
  { label: 'elapsed-budget-ignored', file: owner,
    before: 'const expired = () => Date.now() - startedAt >= BROWSER_LOCAL_RECOVERY_BUDGET.timeMs', after: 'const expired = () => false' },
  { label: 'output-budget-ignored', file: owner,
    before: 'return report.outputBytes <= BROWSER_LOCAL_RECOVERY_BUDGET.outputBytes', after: 'return true' },
  { label: 'current-side-effect-duplicated', file: owner,
    before: 'try { value = await bounded(() => host.dispatch(input.method, [node.ref, ...args.slice(1)], mayDispatch)) }',
    after: 'try { await bounded(() => host.dispatch(input.method, [node.ref, ...args.slice(1)], mayDispatch)); value = await bounded(() => host.dispatch(input.method, [node.ref, ...args.slice(1)], mayDispatch)) }' },
  { label: 'previous-navigation-side-effect-replayed', file: owner,
    before: "const attempt: BrowserLocalRecoveryReport['attempts'][number] = { number, mode: 'observe', status: 'started' }",
    after: "await host.dispatch('gotoUrl', [step.url], () => true)\n    const attempt: BrowserLocalRecoveryReport['attempts'][number] = { number, mode: 'observe', status: 'started' }" },
  { label: 'late-ref-resolution-sends-action', file: owner,
    before: 'const mayDispatch = () => authorized && live() && !expired()', after: 'const mayDispatch = () => true' },
  { label: 'unknown-navigation-resent', file: owner,
    before: "// Observation can confirm a dispatched navigation without sending it twice.\n      const outcome = await check()",
    after: 'await host.dispatch(input.method, args, () => true)\n      const outcome = await check()' },
  { label: 'opaque-action-rejection-retried', file: owner,
    before: "if (!(error instanceof BrowserLocalRecoveryFailure) || error.fact.kind !== 'locator-changed' || error.fact.effects !== 'not-dispatched')",
    after: 'if (false)' },
  { label: 'control-stop-cursor-ignored', file: owner,
    before: "const live = () => !host.signal.aborted && host.control() === 'agent' && host.isCurrent()", after: 'const live = () => true' },
  { label: 'immutable-step-aliased-to-draft', file: owner,
    before: 'step = structuredClone(input.step)', after: 'step = input.step' },
  { label: 'ambiguous-target-selected', file: owner,
    before: 'matches.length !== target.count || target.ordinal < 1', after: 'target.ordinal < 1' },
  { label: 'incomplete-frame-observation-used', file: owner,
    before: 'observation.omittedFrames.length || snapshot.missingFrames.length', after: 'observation.omittedFrames.length' },
  { label: 'navigation-query-hash-ignored', file: owner,
    before: "const exactNavigation = step.kind === 'navigate'", after: 'const exactNavigation = false' },
  { label: 'evidence-unavailable-action-sent', file: owner,
    before: 'if (!await save()) return await finish', after: 'if (false && !await save()) return await finish', all: true },
  { label: 'foreign-outcome-accepted', file: owner,
    before: 'outcome.context.operationId !== identity.operationId', after: 'false' },
  { label: 'unavailable-outcome-claimed-complete', file: owner,
    before: "return outcome.status === 'unavailable' ? undefined : outcome", after: 'return outcome' },
  { label: 'real-pre-action-classification-removed', file: dispatch,
    before: "return new BrowserLocalRecoveryFailure(`Element ${reason.ref} is gone from the page (${reason.reason}). Take a new snapshot().`,\n    'locator-changed', 'not-dispatched')",
    after: 'return new Error(`Element ${reason.ref} is gone from the page.`)' },
  { label: 'real-before-send-control-guard-removed', file: dispatch,
    before: 'context.beforeAction?.()', after: '// control guard removed' },
  { label: 'main-recovery-caller-removed', file: manager,
    before: 'if (!taskPage?.step || !operation.outcome || !signal) throw error', after: 'if (true) throw error' },
  { label: 'undeclared-operation-recovery-action-sent', file: manager,
    before: 'if (!taskPage?.step || !operation.outcome || !signal) throw error', after: 'if (!taskPage?.step || !signal) throw error' },
  { label: 'main-navigation-promise-not-awaited', file: manager,
    before: 'await runBrowserTaskNavigation(() => this.startNavigation(entry, url))',
    after: 'void runBrowserTaskNavigation(() => this.startNavigation(entry, url)).catch(() => {})' },
  { label: 'main-explicit-navigation-error-ignored', file: manager,
    before: "if (entry.error) throw new Error('The original page reports a navigation or renderer error.')",
    after: '// Explicit owner error ignored' },
  { label: 'main-late-recovery-send-authorized', file: manager,
    before: "if (activeRecoveryMayDispatch && !activeRecoveryMayDispatch()) throw new Error('This recovery attempt no longer has dispatch authority.')",
    after: '// Expired attempt authorized' },
  { label: 'asset-current-cursor-authority-removed', file: assets,
    before: "return selected?.runId === execution.runId && !!bound && bound.run.status === 'running' &&\n      bound.version.steps[bound.run.nextStep]?.id === execution.stepId && bound.run.operationIds.includes(operationId)",
    after: 'return true' },
  { label: 'safe-local-recovery-downgraded-as-lossy-healing', file: manager,
    before: "operation.warning = [operation.warning, recovered.report.notice].filter(Boolean).join('\\n')",
    after: "notes.push(recovered.report.notice)\n          operation.warning = notes.join('\\n')" },
  { label: 'main-reviewed-goal-hidden-from-diagnostic', file: manager,
    before: ' Goal: ${report.goal.target ? `${report.goal.target.role} "${report.goal.target.name.slice(0, 256)}" (${report.goal.target.ordinal}/${report.goal.target.count})` : \'navigation\'}; page: ${report.goal.page?.slice(0, 512) ?? \'unknown\'}.',
    after: '' }
]
const requested = process.env.AGENTMUX_LOCAL_RECOVERY_MUTATION_CASES?.split(',').filter(Boolean)
const selectedMutations = requested ? mutations.filter(item => requested.includes(item.label)) : mutations
if (requested) assert.deepEqual(selectedMutations.map(item => item.label).sort(), [...new Set(requested)].sort(), 'Unknown mutation selection')
assert.ok(selectedMutations.length > 0, 'Mutation selection must not be empty')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = entries => Object.fromEntries([...entries].map(([path, bytes]) => [path, digest(bytes)]))
const list = async directory => {
  const paths = []
  for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${item.name}`
    if (item.isDirectory()) paths.push(...await list(path))
    else if (item.isFile()) paths.push(path)
  }
  return paths
}
const inputs = [...new Set(['package.json', 'packages/core/package.json', ...await list('packages/core/src'),
  ...await list('apps/desktop/src/main'), ...await list('apps/desktop/src/shared'), ...tests,
  'apps/desktop/scripts/verify-browser-local-recovery-mutations.mjs'])]
assert.ok(inputs.length > 0 && mutations.length > 0)
const original = new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path))])))
const copy = await mkdtemp('/tmp/agentmux-local-recovery-source-')
const evidence = process.env.AGENTMUX_LOCAL_RECOVERY_MUTATION_OUTPUT
  ? resolve(root, process.env.AGENTMUX_LOCAL_RECOVERY_MUTATION_OUTPUT)
  : await mkdtemp('/tmp/agentmux-local-recovery-evidence-')
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.browser-local-recovery-source-mutations.v1', passed: false,
  sourceBefore: hashes(original), selectedMutations: selectedMutations.map(item => item.label), sharedTreeMutations: 0, cases: [] }
const run = async label => {
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', join(copy, 'vitest.local.config.mts'), '--maxWorkers=1'],
      { cwd: copy, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = '', timedOut = false, force
    const timeout = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM') } catch {}
      force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 1000) }, 40_000)
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', error => { clearTimeout(timeout); clearTimeout(force); no(error) })
    child.on('close', (code, signal) => { clearTimeout(timeout); clearTimeout(force); yes({ code, signal, timedOut, output }) })
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { ...result, log: `${label}.log` }
}
try {
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  for (const directory of ['apps/desktop', 'packages/core']) {
    await mkdir(join(copy, directory), { recursive: true })
    await symlink(join(root, directory, 'node_modules'), join(copy, directory, 'node_modules'))
  }
  for (const [path, bytes] of original) { await mkdir(dirname(join(copy, path)), { recursive: true }); await writeFile(join(copy, path), bytes) }
  await writeFile(join(copy, 'vitest.local.config.mts'), `import { defineConfig } from 'vitest/config'\nexport default defineConfig({ resolve: { alias: { '@agentmux/core': ${JSON.stringify(join(copy, 'packages/core/src/index.ts'))} } }, test: { include: ${JSON.stringify(tests)}, environment: 'node', globalSetup: [], setupFiles: [] } })\n`)
  const baseline = await run('baseline-green')
  assert.equal(baseline.code, 0, baseline.output)
  receipt.baseline = { exit: baseline.code, log: baseline.log }
  for (const mutation of selectedMutations) {
    const { label, file, before, after, all } = mutation
    const source = original.get(file).toString(), occurrences = source.split(before).length - 1
    assert.ok(occurrences > 0, `${label}: source anchor absent`)
    assert.ok(all || occurrences === 1, `${label}: source anchor ambiguous`)
    const changed = all ? source.replaceAll(before, after) : source.replace(before, after)
    await writeFile(join(copy, file), changed)
    const red = await run(`${label}-red`)
    assert.notEqual(red.code, 0, `${label} stayed GREEN`)
    assert.equal(red.timedOut, false, `${label}: process timeout is not product RED`)
    assert.match(red.output, /AssertionError|expected .* to /, `${label}: no behavior assertion RED\n${red.output}`)
    await writeFile(join(copy, file), original.get(file))
    const green = await run(`${label}-restored-green`)
    assert.equal(green.code, 0, `${label}: restored source failed\n${green.output}`)
    receipt.cases.push({ label, file, occurrences, sourceSha256: digest(original.get(file)), mutantSha256: digest(changed),
      red: { exit: red.code, log: red.log }, restoredGreen: { exit: green.code, log: green.log } })
    process.stdout.write(`${label}: Assertion RED -> restored GREEN\n`)
  }
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(copy, path))]))))
  assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  const sourceAfter = hashes(new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path))]))))
  // Concurrent unrelated owners can advance. Subjects/tests used by this proof must be stable.
  receipt.sourceAfter = sourceAfter
  receipt.concurrentPaths = inputs.filter(path => sourceAfter[path] !== receipt.sourceBefore[path])
  for (const path of [owner, dispatch, manager, assets, ...tests]) assert.equal(sourceAfter[path], receipt.sourceBefore[path], `proof source moved: ${path}`)
  receipt.passed = true
  await writeFile(join(evidence, 'source-packet.json.gz'), gzipSync(JSON.stringify(Object.fromEntries([...original].map(([path, bytes]) => [path, bytes.toString('base64')])))))
  for (const path of [owner, dispatch, manager, assets, ...tests]) await writeFile(join(evidence, path.split('/').at(-1) + '.txt'), original.get(path))
} finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await rm(copy, { recursive: true, force: true })
}
process.stdout.write(`Evidence: ${evidence}\n`)
