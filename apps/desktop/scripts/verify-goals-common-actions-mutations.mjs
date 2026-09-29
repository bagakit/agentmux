import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..'), require = createRequire(import.meta.url)
const copy = await realpath(await mkdtemp('/tmp/amx-goals-common-mutation-')), copiedDesktop = join(copy, 'apps/desktop')
const evidence = join(repository, '.tmp/goals-common-actions-mutations', `attempt-${Date.now()}`)
const resolver = 'src/renderer/src/lib/goals-common-actions.ts', config = 'src/renderer/src/lib/goals-common-actions-config.ts'
const component = 'src/renderer/src/components/GoalsCommonActions.tsx', css = 'src/renderer/src/styles/goals.css'
const inputs = [resolver, config, component, css, 'test/goals-common-actions.test.tsx', 'scripts/fixtures/goals-surface/entry.tsx', 'scripts/fixtures/goals-surface/common-actions.cjs']
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(desktop, file))])))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
const receipt = { schema: 'agentmux.goals-common-actions-mutations.v1', passed: false, sharedTreeMutations: 0, userRunTouched: false, sourceBefore: hashes(original), cases: [] }
const focusOnly = process.argv.includes('--focus-only')
const unitCases = [
  { label: 'body-replaced-by-label', file: resolver, before: 'body: prompt.body, executor,', after: 'body: prompt.label, executor,', test: 'references the original full body', assertion: 'Live prompt body is the complete request' },
  { label: 'provider-target-guessed', file: resolver, before: 'executors.find(executor => executor.providerId === prompt.providerId)', after: 'executors[0]', test: 'references the original full body', assertion: 'The visible target is the first configured matching Executor' },
  { label: 'original-library-update-dropped', file: config, before: 'next.composerShortcuts = input.prompts.value;', after: 'next.composerShortcuts = current.composerShortcuts;', test: 'updates the same original library body', assertion: 'Shared library edit updates the original authored body' },
  { label: 'management-starts-agent', file: component, before: 'function select(ref: GoalsCommonActionRef) { setSelected(ref);', after: "function select(ref: GoalsCommonActionRef) { void startGoalExploration('management started an Agent'); setSelected(ref);", test: 'creates one authored body', assertion: 'Management and save never start an Agent' }
]
const renderCases = focusOnly ? [
  { label: 'common-focus-clipped', file: css, before: '.goals-surface .goals-common :is(button,textarea):focus-visible', after: '.goals-entry__actions > button:focus-visible', assertion: 'Common control focus remains inside its scroll-clipped bounds' }
] : [
  { label: 'complete-body-unreadable', file: css, before: 'font: var(--fs-prose)/1.5 var(--font-sans);', after: 'font: 8px/1.5 var(--font-sans);', assertion: 'Complete common action body keeps readable prose size' },
  { label: 'unbounded-common-reading', file: css, before: 'max-height: min(240px, 28vh);', after: 'max-height: none;', assertion: 'Initial and expanded actions share a bounded reading budget' }
]
async function unit(label, test) {
  const runEvidence = join(evidence, label); await mkdir(runEvidence, { recursive: true })
  const log = [], reporter = join(runEvidence, 'test.json')
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const outcome = await runProbeProcess(process.execPath, [vitest, 'run', 'apps/desktop/test/goals-common-actions.test.tsx', '--maxWorkers=1', '--reporter=json', `--outputFile=${reporter}`, ...(test ? ['-t', test] : [])], { temporaryRoot: copy, cwd: copy, env: process.env, timeoutMs: 60000, onLine: line => log.push(line) })
  await writeFile(join(runEvidence, 'process.log'), log.join('\n'))
  const report = JSON.parse(await readFile(reporter, 'utf8'))
  assert.ok(report.numTotalTests > 0, 'The actual owning suite was collected')
  assert.ok(report.numPassedTests + report.numFailedTests > 0, 'The selected actual owning behavior executed')
  return { outcome, report, evidence: runEvidence }
}
async function render(label) {
  const output = join(copy, 'compiled'), runEvidence = join(evidence, label), fixture = join(copiedDesktop, 'scripts/fixtures/goals-surface')
  await mkdir(runEvidence, { recursive: true })
  try {
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, build: { outDir: output, minify: false, sourcemap: true, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
    const compiled = {}; let outputBytes = 0
    for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const file = join(entry.parentPath, entry.name), bytes = await readFile(file); outputBytes += bytes.length; compiled[file.slice(output.length + 1)] = digest(bytes) }
    assert.ok(Object.keys(compiled).length > 0); await writeFile(join(runEvidence, 'compiled.json'), JSON.stringify(compiled, null, 2))
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const log = [], outcome = await runProbeProcess(require('electron'), [join(fixture, 'common-actions.cjs'), join(output, 'index.html'), copy, runEvidence, focusOnly ? 'focus-regression-only' : 'assertions-only'], { temporaryRoot: copy, cwd: copy, env, timeoutMs: 60000, onLine: line => log.push(line) })
    await writeFile(join(runEvidence, 'process.log'), log.join('\n'))
    return { outcome, render: JSON.parse(await readFile(join(runEvidence, 'render.json'), 'utf8')), evidence: runEvidence, compiledOutput: { files: Object.keys(compiled).length, bytes: outputBytes, removedAfterProcessExit: true } }
  } finally { await rm(output, { recursive: true, force: true }) }
}
async function mutate(mutation, run) {
  const source = original.get(mutation.file).toString(); assert.equal(source.split(mutation.before).length - 1, 1, `Unique private Source anchor: ${mutation.label}`)
  let red
  try {
    await writeFile(join(copiedDesktop, mutation.file), source.replace(mutation.before, mutation.after))
    red = await run(`${mutation.label}-red`, mutation.test)
    assert.ok(red.outcome.exitCode > 0, 'A concrete owning assertion rejected the private mutation')
    if (red.report) {
      const failures = red.report.testResults.flatMap(result => result.assertionResults).filter(test => test.status === 'failed')
      assert.ok(failures.length > 0, 'At least one actual owning test failed')
      assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError') && message.includes(mutation.assertion))), `Expected concrete behavioral assertion: ${mutation.assertion}`)
    } else {
      assert.equal(red.render.passed, false); assert.equal(red.render.failure?.name, 'AssertionError', 'Setup/import/capacity failure is not behavioral RED')
      assert.ok(red.render.failure.message.includes(mutation.assertion), `Expected concrete Renderer assertion: ${mutation.assertion}`)
    }
  } finally { await writeFile(join(copiedDesktop, mutation.file), original.get(mutation.file)) }
  assert.equal(digest(await readFile(join(copiedDesktop, mutation.file))), receipt.sourceBefore[mutation.file], 'Exact private Source bytes restored')
  const green = await run(`${mutation.label}-restore-green`, mutation.test)
  assert.equal(green.outcome.exitCode, 0, JSON.stringify(green.render?.failure)); assert.equal(green.report ? green.report.success : green.render.passed, true)
  receipt.cases.push({ ...mutation, red, restore: green }); await writeFile(join(evidence, 'progress.json'), JSON.stringify({ completed: receipt.cases.map(item => item.label), sourceBefore: receipt.sourceBefore }, null, 2))
  console.log(JSON.stringify({ completed: mutation.label, red: red.outcome.exitCode, restore: green.outcome.exitCode }))
}
try {
  await mkdir(evidence, { recursive: true }); await mkdir(copiedDesktop, { recursive: true })
  for (const directory of ['src', 'resources', 'scripts/fixtures/goals-surface', 'test/helpers']) await cp(join(desktop, directory), join(copiedDesktop, directory), { recursive: true })
  await cp(join(desktop, 'test/goals-common-actions.test.tsx'), join(copiedDesktop, 'test/goals-common-actions.test.tsx'))
  await symlink(join(desktop, 'node_modules'), join(copiedDesktop, 'node_modules')); await symlink(join(repository, 'node_modules'), join(copy, 'node_modules')); await symlink(join(repository, 'packages'), join(copy, 'packages'))
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.setup.ts', 'vitest.dist-freshness.ts']) await cp(join(repository, file), join(copy, file))
  for (const file of ['package.json', 'tsconfig.json']) await cp(join(desktop, file), join(copiedDesktop, file))
  const privateConfig = join(copy, 'vitest.config.ts'), text = await readFile(privateConfig, 'utf8')
  assert.equal(text.split('export default defineConfig({').length - 1, 1)
  await writeFile(privateConfig, text.replace('export default defineConfig({', `export default defineConfig({\n  server: { fs: { allow: ${JSON.stringify([copy, repository])} } },`))
  receipt.privateVerificationBoundary = { sameOwningTests: true, sameDistFreshnessGuard: true, filesystemAllow: [copy, repository], reason: 'Linked exact workspace package URL assets stay readable from the private proof root.' }
  if (!focusOnly) {
    receipt.unitBaseline = await unit('unit-baseline-green'); assert.equal(receipt.unitBaseline.outcome.exitCode, 0); assert.equal(receipt.unitBaseline.report.success, true)
    for (const mutation of unitCases) await mutate(mutation, unit)
  }
  receipt.renderBaseline = await render('render-baseline-green'); assert.equal(receipt.renderBaseline.outcome.exitCode, 0, JSON.stringify(receipt.renderBaseline.render.failure)); assert.equal(receipt.renderBaseline.render.passed, true)
  for (const mutation of renderCases) await mutate(mutation, render)
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(desktop, file))])))); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copiedDesktop, file))])))); assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await stopProbeProcesses(process.pid + 1000000000, copy); receipt.remaining = await listProbeProcesses(process.pid + 1000000000, copy); assert.deepEqual(receipt.remaining, [])
  await rm(copy, { recursive: true, force: true }); receipt.cleanup = { privateCopyRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ passed: receipt.passed, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json'), failure: receipt.failure })); if (!receipt.passed) process.exitCode = 1
