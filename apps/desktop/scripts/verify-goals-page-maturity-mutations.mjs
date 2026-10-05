import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..'), require = createRequire(import.meta.url)
const copy = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amx-goals-maturity-mutation-"))), copiedDesktop = join(copy, 'apps/desktop')
assert.ok(process.argv.slice(2).every(flag=>['--return-only','--density-only','--cohesion-only'].includes(flag)), 'Unknown maturity mutation mode')
const densityOnly=process.argv.includes('--density-only')
const cohesionOnly=process.argv.includes('--cohesion-only')
assert.ok(!cohesionOnly || process.argv.slice(2).length === 1, 'Cohesion mutations are one bounded mode')
const evidenceRoot=process.env.AGENTMUX_GOALS_MUTATION_EVIDENCE_ROOT||join(repository,'.tmp/goals-page-maturity-mutations')
const evidence = join(evidenceRoot, ("attempt-" + (globalThis.crypto.randomUUID()) + ""))
const densityBaseline=process.env.AGENTMUX_GOALS_DENSITY_BASELINE||join(process.env.AGENTMUX_GOALS_EVIDENCE_ROOT||join(repository,'.tmp/goals-surface'),'density-baseline.json')
const component = 'src/renderer/src/components/GlobalBoardSurface.tsx', alignment = 'src/renderer/src/components/GoalAlignment.tsx', css = 'src/renderer/src/styles/goals.css'
const inputs = [component, alignment, css, 'src/renderer/src/components/GoalDetail.tsx', 'src/renderer/src/components/GoalsCommonActions.tsx', 'src/renderer/src/components/GoalProperties.tsx', 'src/renderer/src/lib/goal-presentation.ts', 'src/renderer/src/lib/workspace-projects.ts', ...(!densityOnly?['test/goals-page-maturity.test.tsx']:[]), 'scripts/fixtures/goals-surface/entry.tsx', 'scripts/fixtures/goals-surface/maturity.cjs']
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(desktop, file))])))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
const receipt = { schema: 'agentmux.goals-page-maturity-mutations.v1', mode:cohesionOnly?'cohesion':densityOnly?'density':'maturity', passed: false, sharedTreeMutations: 0, userRunTouched: false, sourceBefore: hashes(original), cases: [] }
const unitCases = cohesionOnly ? [
  { label: 'menu-escape-closes-original-goal', file: component, before: `    if ((event.target as HTMLElement).closest('[role="menu"], [role="dialog"]')) return\n`, after: '', test: 'dismisses Goal actions and delete confirmation', assertion: 'Menu Escape keeps the original Goal open' },
  { label: 'chosen-status-filter-disconnected', file: component, before: 'onValueChange={value => setStatusFilter(value as typeof statusFilter)}', after: "onValueChange={value => setStatusFilter('all')}", test: 'keeps the selected filter and Goal', assertion: 'Chosen work status filters the current original Goals' },
  { label: 'filtered-board-hides-match-behind-empty-columns', file: component, before: "const visibleStatuses = statusFilter === 'all' ? DEMAND_STATUS_IDS : [statusFilter]", after: 'const visibleStatuses = DEMAND_STATUS_IDS', test: 'keeps the selected filter and Goal', assertion: 'Explicit status filtering presents only its matching board column' },
  { label: 'modal-menu-leaks-pointer-lock', file: 'src/renderer/src/components/GoalDetail.tsx', before: '<Menu.Root modal={false}>', after: '<Menu.Root>', test: 'dismisses Goal actions and delete confirmation', assertion: 'Goal actions menu keeps the surrounding workbench nonmodal' },
  { label: 'delete-cancel-loses-action-focus', file: 'src/renderer/src/components/GoalDetail.tsx', before: 'actionsRef.current?.focus(); setDeleteRequested(true)', after: 'setDeleteRequested(true)', test: 'dismisses Goal actions and delete confirmation', assertion: 'Cancelling delete returns focus to Goal actions' }
] : [
  { label: 'current-row-fact-disconnected', file: component, before: 'goalNextStep(demand)', after: "'Open a goal'", test: 'states current facts in nonempty rows', assertion: 'Goal rows describe actual current target/result facts' },
  { label: 'selected-goal-common-owner-uncompacted', file: component, before: 'contextCompact={Boolean(selectedDemandId)}', after: 'contextCompact={false}', test: 'temporarily compacts the same common instance', assertion: 'Selected Goal compacts entry without replacing its draft owner' },
  { label: 'opaque-project-binding-dropped', file: alignment, before: '.find(project => project.id === demand.projectId)', after: '.find(() => false)', test: 'opens opaque Project evidence through its preferred Workspace', assertion: 'Opaque Project resolves the preferred Workspace in the actual file pipeline' }
]
const returnOnly = process.argv.includes('--return-only')
const renderCases = [
  { label: 'returned-focus-under-scrollbar', file: css, before: '.goals-common--managing .goals-common__manager { min-height: 0; overflow: auto; padding-inline-end: var(--sp-5); }', after: '.goals-common--managing .goals-common__manager { min-height: 0; overflow: auto; padding-inline-end: 0; }', test: 'return-only', assertion: 'Returned focus stays clear of the manager scrollbar' },
  { label: 'narrow-detail-container-query-self-targeted', file: css, before: '.goals-surface--detail-open .goals-layout { flex-direction: column; }', after: '.goals-surface--detail-open { flex-direction: column; }', test: 'narrow-layout-only', assertion: 'Selected Goal detail occupies a real readable viewport' },
  { label: 'reading-heading-hierarchy-flattened', file: css, before: '.goals-document h2 { display: flex; gap: var(--sp-4); margin: 0 0 var(--sp-4); color: var(--text); font-size: var(--fs-title);', after: '.goals-document h2 { display: flex; gap: var(--sp-4); margin: 0 0 var(--sp-4); color: var(--text); font-size: var(--fs-body);', assertion: 'Reading responsibilities have stronger heading hierarchy than prose' }
]
const densityCases=[
  {label:'top-actions-restacked',file:css,before:'.goals-entry__actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));',after:'.goals-entry__actions { display: grid; grid-template-columns: minmax(0, 1fr);',test:'density-start-only',assertion:'Wide full original requests are arranged in parallel'},
  {label:'detail-document-centered-away-from-boundary',file:css,before:'.goals-document { box-sizing: border-box; width: 100%; max-width: 960px; margin: 0;',after:'.goals-document { box-sizing: border-box; width: 100%; max-width: 960px; margin: 0 auto;',test:'density-detail-only',assertion:'Goal document starts 16–24px from the detail boundary'}
]
async function unit(label, test) {
  const runEvidence = join(evidence, label); await mkdir(runEvidence, { recursive: true })
  const log = [], reporter = join(runEvidence, 'test.json')
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const outcome = await runProbeProcess(process.execPath, [vitest, 'run', 'apps/desktop/test/goals-page-maturity.test.tsx', '--maxWorkers=1', '--reporter=json', `--outputFile=${reporter}`, ...(test ? ['-t', test] : [])], { temporaryRoot: copy, cwd: copy, env: process.env, timeoutMs: 60000, onLine: line => log.push(line) })
  await writeFile(join(runEvidence, 'process.log'), log.join('\n'))
  const report = JSON.parse(await readFile(reporter, 'utf8'))
  assert.ok(report.numTotalTests > 0, 'The actual owning suite was collected')
  assert.ok(report.numPassedTests + report.numFailedTests > 0, 'The selected actual owning behavior executed')
  return { outcome, report, evidence: runEvidence }
}
async function render(label, scope = 'legibility-only') {
  const output = join(copy, 'compiled'), runEvidence = join(evidence, label), fixture = join(copiedDesktop, 'scripts/fixtures/goals-surface')
  await mkdir(runEvidence, { recursive: true })
  try {
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, build: { outDir: output, minify: false, sourcemap: true, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
    const compiled = {}; let outputBytes = 0
    for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const file = join(entry.parentPath, entry.name), bytes = await readFile(file); outputBytes += bytes.length; compiled[file.slice(output.length + 1)] = digest(bytes) }
    assert.ok(Object.keys(compiled).length > 0); await writeFile(join(runEvidence, 'compiled.json'), JSON.stringify(compiled, null, 2))
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const log = [], outcome = await runProbeProcess(require('electron'), [join(fixture, 'maturity.cjs'), join(output, 'index.html'), copy, runEvidence, scope,...(densityOnly?[densityBaseline]:[])], { temporaryRoot: copy, cwd: copy, env, timeoutMs: 60000, onLine: line => log.push(line) })
    await writeFile(join(runEvidence, 'process.log'), log.join('\n'))
    return { outcome, render: JSON.parse(await readFile(join(runEvidence, 'render.json'), 'utf8')), evidence: runEvidence, compiledOutput: { files: Object.keys(compiled).length, bytes: outputBytes, removedAfterProcessExit: true } }
  } finally { await stopProbeProcesses(process.pid + 1000000000, copy); assert.deepEqual(await listProbeProcesses(process.pid + 1000000000, copy), []); await rm(output, { recursive: true, force: true }) }
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
  for (const directory of ['src', 'resources', 'scripts/lib', 'scripts/fixtures/goals-surface', ...(!densityOnly?['test/helpers']:[])]) await cp(join(desktop, directory), join(copiedDesktop, directory), { recursive: true })
  if(!densityOnly)await cp(join(desktop, 'test/goals-page-maturity.test.tsx'), join(copiedDesktop, 'test/goals-page-maturity.test.tsx'))
  await symlink(join(desktop, 'node_modules'), join(copiedDesktop, 'node_modules')); await symlink(join(repository, 'node_modules'), join(copy, 'node_modules')); await symlink(join(repository, 'packages'), join(copy, 'packages'))
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.setup.ts', 'vitest.dist-freshness.ts']) await cp(join(repository, file), join(copy, file))
  for (const file of ['package.json', 'tsconfig.json']) await cp(join(desktop, file), join(copiedDesktop, file))
  const privateConfig = join(copy, 'vitest.config.ts'), text = await readFile(privateConfig, 'utf8')
  assert.equal(text.split('export default defineConfig({').length - 1, 1)
  await writeFile(privateConfig, text.replace('export default defineConfig({', `export default defineConfig({\n  server: { fs: { allow: ${JSON.stringify([copy, repository])} } },`))
  receipt.privateVerificationBoundary = { sameOwningTests: true, sameDistFreshnessGuard: true, filesystemAllow: [copy, repository], reason: 'Linked exact workspace package URL assets stay readable from the private proof root.' }
  if (!returnOnly&&!densityOnly) {
    receipt.unitBaseline = await unit('unit-baseline-green'); assert.equal(receipt.unitBaseline.outcome.exitCode, 0); assert.equal(receipt.unitBaseline.report.success, true)
    for (const mutation of unitCases) await mutate(mutation, unit)
  }
  if(densityOnly){const bytes=await readFile(densityBaseline);receipt.densityBaseline={path:densityBaseline,sha256:digest(bytes),sourceCommit:JSON.parse(bytes).sourceCommit}}
  if (!cohesionOnly) {
    receipt.renderBaseline = await render('render-baseline-green',densityOnly?'density-start-only':undefined); assert.equal(receipt.renderBaseline.outcome.exitCode, 0, JSON.stringify(receipt.renderBaseline.render.failure)); assert.equal(receipt.renderBaseline.render.passed, true)
    for (const mutation of densityOnly?densityCases:renderCases.filter(item => !returnOnly || item.label === 'returned-focus-under-scrollbar')) await mutate(mutation, render)
  }
  if(cohesionOnly)assert.equal(receipt.cases.length,5,'All five concrete interaction faults proved behavioral RED and exact restore GREEN')
  if(densityOnly)assert.equal(receipt.cases.length,2,'Exactly two actual production density seams proved assertion RED and exact restore GREEN')
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
