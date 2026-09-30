import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

// Qualification performs real mounted production mutations. The approved task gate uses --receipt
// to consume those exact reports and current inputs without modifying the shared product again.
const root = resolve(import.meta.dirname, '../../..')
let consume = false, output = 'docs/reviews/evidence/launcher-interaction-motion-2026-10-04'
for (let index = 2; index < process.argv.length; index++) {
  const [flag, inline] = process.argv[index].split('=')
  if (flag === '--receipt') { assert.equal(inline, undefined); consume = true; continue }
  assert.equal(flag, '--output', `Unknown verifier argument: ${flag}`)
  output = inline ?? process.argv[++index]
  assert(output && !output.startsWith('--'), 'Missing evidence output path')
}
const evidence = resolve(root, output), receiptPath = resolve(evidence, 'source-receipt.json')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const bind = path => ({ path, sha256: sha(readFileSync(resolve(root, path))) })
const relative = path => path.replace(`${root}/`, '')
const component = name => `apps/desktop/src/renderer/src/components/${name}.tsx`
const sourcePaths = [
  component('NewTabSurface'), component('LauncherEnvironment'), component('LaunchOptionControls'),
  component('LauncherSecondarySurfaces'), component('settings/LiquidSelectionSurface'),
  component('LauncherMoteAction'), component('LauncherResumePicker'), component('WorkspaceWorkbench'),
  'apps/desktop/src/renderer/src/lib/launcher-state.ts',
  'apps/desktop/src/renderer/src/lib/primary-mote-executor.ts',
  ...['launcher', 'settings-materials', 'surfaces', 'tokens', 'index'].map(name => `apps/desktop/src/renderer/src/styles/${name}.css`)
]
const testPaths = [
  'apps/desktop/test/launcher-interaction-motion.test.tsx',
  'apps/desktop/test/launcher-entry-polish.test.tsx', 'apps/desktop/test/launch-option-controls.test.tsx',
  'apps/desktop/test/launch-naming.test.ts',
  'apps/desktop/test/new-tab-resource-contract.test.ts',
  'apps/desktop/test/browser-address-input-callers.test.tsx',
  'apps/desktop/test/settings-liquid-selection.test.tsx', 'apps/desktop/test/settings-prompts-liquid.test.tsx',
  'apps/desktop/test/presence-exit-animation.test.ts',
  'apps/desktop/test/vacuous-on-empty-predicate.test.ts', 'apps/desktop/test/sliced-scan-surface-not-empty.test.ts'
]
const helpers = ['apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/styles.ts',
  'apps/desktop/scripts/fixtures/settings-liquid-motion/product-dom.tsx']
const producer = 'apps/desktop/scripts/verify-launcher-interaction-motion-source.mjs'
const schema = 'agentmux.launcher-interaction-motion-source.v1'

function checkInputs(receipt) {
  assert.equal(receipt.schema, schema)
  assert.equal(receipt.status, 'passed')
  assert.deepEqual(receipt.sourceBindings.map(item => item.path), sourcePaths)
  assert.deepEqual(receipt.testBindings.map(item => item.path), [...testPaths, ...helpers])
  for (const input of [...receipt.sourceBindings, ...receipt.testBindings, receipt.verificationBinding]) {
    assert.equal(bind(input.path).sha256, input.sha256, `Qualified input changed: ${input.path}`)
  }
  assert.equal(receipt.verificationBinding.path, producer)
  assert.equal(receipt.sourceDigest, sha(JSON.stringify(receipt.sourceBindings)))
}
function checkReport(run, expectedGreen) {
  const bytes = readFileSync(resolve(root, run.report))
  assert.equal(sha(bytes), run.reportSha256, `Actual test report changed: ${run.report}`)
  assert.equal(bind(run.log).sha256, run.logSha256, `Actual test log changed: ${run.log}`)
  const actual = JSON.parse(bytes)
  assert(actual.numTotalTests > 0 && actual.testResults.length > 0, 'The original test collection must be nonempty')
  const failed = actual.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed'))
  assert.equal(run.tests, actual.numTotalTests)
  assert.equal(run.passed, actual.numPassedTests)
  if (expectedGreen) {
    assert.equal(run.exitCode, 0)
    assert.equal(actual.numFailedTests, 0)
    assert.equal(failed.length, 0)
    assert(actual.numPassedTests > 0)
  } else {
    assert.notEqual(run.exitCode, 0)
    assert(failed.length > 0, 'A collection/tool failure cannot replace Assertion RED')
    assert(failed.some(test => test.failureMessages.some(message => /AssertionError|expected .*to /s.test(message))), 'Actual assertions must fail')
  }
}
function productCallers() {
  const owners = [
    ['NewTabSurface', component('NewTabSurface')], ['LiquidSelectionSurface', component('settings/LiquidSelectionSurface')],
    ['LauncherEnvironment', component('LauncherEnvironment')], ['LaunchRefine', component('LaunchOptionControls')],
    ['LauncherSecondarySurfaces', component('LauncherSecondarySurfaces')]
  ]
  return owners.map(([symbol, definition]) => {
    const uses = []
    for (const path of sourcePaths.filter(path => path.endsWith('.tsx') && path !== definition)) {
      const source = readFileSync(resolve(root, path), 'utf8')
      const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      function visit(node) {
        const expression = ts.isCallExpression(node) ? node.expression : ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName : null
        if (expression && ts.isIdentifier(expression) && expression.text === symbol) {
          uses.push({ path, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, use: node.getText(parsed).slice(0, 220) })
        }
        ts.forEachChild(node, visit)
      }
      visit(parsed)
    }
    assert(uses.length > 0, `${symbol}: no actual product caller outside its definition/import/tests`)
    return { symbol, definition, uses }
  })
}
const mutants = [
  { id: 'remove-connected-liquid-owner', path: component('NewTabSurface'),
    from: '<LiquidSelectionSurface selected={displayedExecutorId || null} active={visible && presentationActive} targetAttribute="data-executor-id" />',
    to: '{/* mutation: disconnected shared selection owner */}', test: 'native Agent buttons' },
  { id: 'keep-retained-liquid-active', path: component('NewTabSurface'),
    from: 'active={visible && presentationActive} targetAttribute="data-executor-id"',
    to: 'active={true} targetAttribute="data-executor-id"', test: 'retained presentations' },
  { id: 'host-exit-remains-interactive', path: component('LauncherEnvironment'),
    from: 'inert={!open}', to: 'inert={false}', test: 'Host exits become inert' },
  { id: 'options-exit-remains-interactive', path: component('LaunchOptionControls'),
    from: 'inert={!expanded}', to: 'inert={false}', test: 'Options rapid reopening' },
  { id: 'retained-host-keeps-portal', path: component('NewTabSurface'),
    from: 'check={hostCheck} displayPath={displayPath} active={motionActive}',
    to: 'check={hostCheck} displayPath={displayPath} active={true}', test: 'retained presentations|document visibility' },
  { id: 'ignore-document-visibility', path: component('NewTabSurface'),
    from: 'const motionActive = visible && presentationActive && documentVisible',
    to: 'const motionActive = visible && presentationActive', test: 'document visibility' },
  { id: 'browser-release-drifts-from-css-token', path: component('LauncherSecondarySurfaces'),
    from: "    const token = getComputedStyle(browserRow.current!).getPropertyValue('--dur-enter').trim()\n    const duration = /^(\\d+(?:\\.\\d+)?|\\.\\d+)(ms|s)$/.exec(token)\n    const milliseconds = duration ? Number(duration[1]) * (duration[2] === 's' ? 1000 : 1) : 0",
    to: '    const milliseconds = 180', test: 'real token duration' },
  { id: 'reduced-browser-exit-never-released', path: component('LauncherSecondarySurfaces'),
    from: 'const stop = () => { if (document.hidden || reduced.matches) cancelBrowserClose() }',
    to: 'const stop = () => { /* mutation: reduced/hidden presentation keeps exiting input */ }', test: 'newly reduced or hidden' }
]

if (consume) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  checkInputs(receipt)
  checkReport(receipt.baseline, true)
  checkReport(receipt.restored, true)
  assert.deepEqual(receipt.mutations.map(item => item.id), mutants.map(item => item.id))
  for (const mutation of receipt.mutations) {
    assert.equal(mutation.status, 'assertion-red-exact-restore-green')
    assert.equal(mutation.originalSha256, receipt.sourceBindings.find(item => item.path === mutation.path)?.sha256)
    assert.notEqual(mutation.originalSha256, mutation.mutatedSha256)
    checkReport(mutation.red, false)
    checkReport(mutation.restored, true)
  }
  assert.deepEqual(receipt.callers, productCallers())
  assert.equal(receipt.typecheck.exitCode, 0)
  assert.equal(receipt.typecheck.command, 'node_modules/.bin/tsc --noEmit -p apps/desktop/tsconfig.json')
  assert.equal(bind(receipt.typecheck.log).sha256, receipt.typecheck.logSha256)
  process.stdout.write(`${JSON.stringify({ status: 'passed', receipt: relative(receiptPath), sourceDigest: receipt.sourceDigest,
    tests: receipt.restored.tests, mutations: receipt.mutations.length, callers: receipt.callers.length, mode: 'read-only-current-proof' })}\n`)
  process.exit(0)
}

mkdirSync(evidence, { recursive: true })
const sourceBindings = sourcePaths.map(bind), testBindings = [...testPaths, ...helpers].map(bind)
const verificationBinding = bind(producer)
function runTests(label, paths = testPaths, name) {
  const report = resolve(evidence, `${label}.vitest.json`), log = resolve(evidence, `${label}.log`)
  const args = ['run', ...paths, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  if (name) args.push('-t', name)
  const result = spawnSync(resolve(root, 'node_modules/.bin/vitest'), args, { cwd: root, encoding: 'utf8', timeout: 120_000 })
  writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error}` : ''}`)
  assert(!result.error, `${label}: test command did not complete`)
  const bytes = readFileSync(report), actual = JSON.parse(bytes)
  assert(actual.numTotalTests > 0 && actual.testResults.length > 0, `${label}: tests must be collected`)
  const failed = actual.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed')
    .map(test => ({ file: relative(file.name), name: test.fullName, messages: test.failureMessages })))
  return { label, command: `node_modules/.bin/vitest ${args.join(' ')}`, exitCode: result.status,
    tests: actual.numTotalTests, passed: actual.numPassedTests, failed,
    report: relative(report), reportSha256: sha(bytes), log: relative(log), logSha256: bind(relative(log)).sha256 }
}
const baseline = runTests('source-baseline')
checkReport(baseline, true)
const mutations = []
for (const mutant of mutants) {
  const path = resolve(root, mutant.path), original = readFileSync(path)
  assert.equal(sha(original), sourceBindings.find(input => input.path === mutant.path)?.sha256, 'Candidate changed; preserve concurrent work before retrying')
  assert.equal(original.toString().split(mutant.from).length, 2, `Mutation anchor must occur once: ${mutant.id}`)
  const mutated = original.toString().replace(mutant.from, mutant.to)
  writeFileSync(path, mutated)
  let red
  try {
    red = runTests(`mutation-${mutant.id}`, [testPaths[0]], mutant.test)
    checkReport(red, false)
  } finally {
    assert.equal(sha(readFileSync(path)), sha(mutated), `${mutant.id}: concurrent edit detected; do not overwrite it`)
    writeFileSync(path, original)
    assert.equal(sha(readFileSync(path)), sha(original), `${mutant.id}: restore original bytes exactly`)
  }
  const restored = runTests(`restore-${mutant.id}`, [testPaths[0]], mutant.test)
  checkReport(restored, true)
  mutations.push({ id: mutant.id, path: mutant.path, originalSha256: sha(original), mutatedSha256: sha(mutated),
    status: 'assertion-red-exact-restore-green', red, restored })
  process.stdout.write(`${mutant.id}: Assertion RED / exact restore GREEN\n`)
}
const restored = runTests('source-final-restored')
checkReport(restored, true)
const callers = productCallers()
const typecheck = spawnSync(resolve(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', 'apps/desktop/tsconfig.json'], { cwd: root, encoding: 'utf8', timeout: 120_000 })
const typecheckLog = relative(resolve(evidence, 'source-typecheck.log'))
writeFileSync(resolve(root, typecheckLog), `${typecheck.stdout ?? ''}${typecheck.stderr ?? ''}${typecheck.error ? `\n${typecheck.error}` : ''}`)
assert(!typecheck.error && typecheck.status === 0, 'The actual current product typecheck must pass')
const receipt = { schema, status: 'passed', feature: 'f-2hm8f4ca7', task: 'T-003', recordedAt: new Date().toISOString(),
  sourceBindings, testBindings, verificationBinding, sourceDigest: sha(JSON.stringify(sourceBindings)), baseline, mutations, restored, callers,
  typecheck: { command: 'node_modules/.bin/tsc --noEmit -p apps/desktop/tsconfig.json', exitCode: typecheck.status,
    log: typecheckLog, logSha256: bind(typecheckLog).sha256 },
  packaging: 'not-requested-not-run', installation: 'not-requested-not-run',
  boundary: 'Original production React/Store/shared Liquid/Radix owners are mounted. Native API/layout/animation boundaries are controlled; actual Renderer pixels, timing, keyboard, CSS mutations and two-process recovery have independent Root qualification.' }
checkInputs(receipt)
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ status: 'passed', receipt: relative(receiptPath), tests: restored.tests, mutations: mutations.length, callers: callers.length })}\n`)
