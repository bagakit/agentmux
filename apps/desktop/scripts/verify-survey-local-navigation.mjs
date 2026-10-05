import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const evidence = resolve(root, '.tmp/survey-local-navigation')
mkdirSync(evidence, { recursive: true })
const test = 'apps/desktop/test/navigation-contexts.test.tsx'
const config = 'apps/desktop/scripts/fixtures/navigation-contexts.config.mts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const chain = [
  ['apps/desktop/src/renderer/src/App.tsx', 'state.setSurveyZoneSelection(surveySelectReference(state.surveyZoneSelection, reference))'],
  ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'if (projection) selectWorkbenchProjectionTab(projection, group.id, tab)'],
  ['apps/desktop/src/renderer/src/lib/workbench-projection.ts', 'scope.onSelect(reference)'],
  [store, "if (request.operation === 'focus')"]
]
const hash = value => createHash('sha256').update(value).digest('hex')
const sources = [...new Set([test, config, ...chain.map(([file]) => file)])]
const before = Object.fromEntries(sources.map(file => [file, hash(readFileSync(resolve(root, file)))]))
for (const [file, consumer] of chain) assert.ok(readFileSync(resolve(root, file), 'utf8').includes(consumer), 'Missing actual consumer: ' + file)

function run(name, mutation = '') {
  const report = resolve(evidence, name + '.json'), witness = resolve(evidence, name + '.loaded.jsonl')
  rmSync(report, { force: true }); rmSync(witness, { force: true })
  const log = openSync(resolve(evidence, name + '.log'), 'w')
  const processResult = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
    test, '--reporter=json', '--outputFile=' + report], { cwd: root, stdio: ['ignore', log, log],
    env: { ...process.env, AGENTMUX_NAVIGATION_MUTATION: mutation, AGENTMUX_NAVIGATION_WITNESS: witness } })
  closeSync(log); assert.ifError(processResult.error)
  const data = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(data.numTotalTestSuites, 1)
  assert.equal(data.testResults.length, 1, 'Exactly the named suite must load')
  assert.equal(data.testResults[0].message, '', 'Suite loading or setup failed')
  assert.ok(data.numTotalTests > 0, 'Empty collections do not prove navigation')
  assert.equal(data.testResults[0].assertionResults.length, data.numTotalTests)
  assert.equal(data.numPendingTests, 0); assert.equal(data.numTodoTests, 0)
  return { processResult, data, witness }
}
const baseline = run('baseline')
assert.equal(baseline.processResult.status, 0, 'Inspect baseline.log')
assert.equal(baseline.data.numFailedTests, 0)
assert.equal(baseline.data.numFailedTestSuites, 0)
assert.equal(baseline.data.numPassedTests, baseline.data.numTotalTests)
for (const name of ['keeps Survey selection and semantic Agent history local through the actual Survey pointer owner',
  'keeps a real Survey Tab click local while retaining the original Work occurrence',
  'keeps explicit public focus reachable from Survey without overwriting its local selection']) {
  assert.ok(baseline.data.testResults[0].assertionResults.some(test => test.fullName === name && test.status === 'passed'), 'Required product path did not execute: ' + name)
}
const mutant = run('implicit-work-write', 'survey-follows-work')
const loaded = readFileSync(mutant.witness, 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.equal(loaded.length, 1); assert.equal(loaded[0].mutation, 'survey-follows-work')
assert.equal(loaded[0].original, before[store]); assert.notEqual(loaded[0].loaded, loaded[0].original)
assert.equal(mutant.data.numTotalTests, baseline.data.numTotalTests, 'Load or collection failure is not a killed mutant')
assert.ok(mutant.processResult.status !== 0 && mutant.data.numFailedTests > 0, 'Implicit Work write mutant survived')
assert.equal(mutant.data.numFailedTestSuites, 1)
// This Vitest JSON reporter has no numRuntimeErrorTestSuites field. Inspect the
// actual case failures instead: a timeout, import or runtime exception is not evidence.
const failed = mutant.data.testResults[0].assertionResults.filter(test => test.status === 'failed')
assert.equal(failed.length, mutant.data.numFailedTests)
for (const test of failed) {
  assert.ok(test.failureMessages.length > 0)
  for (const message of test.failureMessages) assert.match(message,
    /^AssertionError: expected .* to be .*\/\/ Object\.is equality\n/, 'Only the Work reference matcher may kill this regression')
}
for (const name of ['keeps Survey selection and semantic Agent history local through the actual Survey pointer owner',
  'keeps a real Survey Tab click local while retaining the original Work occurrence']) {
  assert.ok(failed.some(test => test.fullName === name), 'Required Survey consumer did not reject the regression: ' + name)
}
for (const file of sources) assert.equal(hash(readFileSync(resolve(root, file))), before[file], 'Source changed during verification: ' + file)
const receipt = { passed: true, baseline: { total: baseline.data.numTotalTests, passed: baseline.data.numPassedTests },
  mutant: { collected: mutant.data.numTotalTests, failed: mutant.data.numFailedTests,
    assertionFailures: failed.map(test => test.fullName), loaded: loaded[0] },
  consumers: chain, sources: before }
writeFileSync(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ baseline: receipt.baseline, mutant: { collected: receipt.mutant.collected, failed: receipt.mutant.failed }, consumers: chain.length }))
