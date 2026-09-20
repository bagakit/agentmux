import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const proof = resolve(root, '.bagakit/feature-tracker/focus-lane-information-artifacts')
const read = name => JSON.parse(readFileSync(resolve(proof, name), 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const slice = process.argv.includes('--slice') ? process.argv[process.argv.indexOf('--slice') + 1] : 'joined'
assert.ok(['projection', 'lanes', 'joined'].includes(slice), 'Unknown qualification slice')
function verifyProjection() {
 const receipt = read('projection-qualification.json'), inputs = read('projection-inputs.json'), runs = read('projection-execution.json')
 assert.equal(receipt.feature, 'f-2eq8fwvcm'); assert.equal(receipt.scope, 'projection'); assert.equal(receipt.installed, false)
 execFileSync('git', ['merge-base', '--is-ancestor', receipt.commit, 'main'], { cwd: root })
 for (const [name, expected] of Object.entries(inputs)) {
  assert.equal(hash(execFileSync('git', ['show', receipt.commit + ':' + name], { cwd: root })), expected, name)
 }
 assert.ok(Object.keys(inputs).length >= 6)
 for (const label of ['original', 'candidate', 'unknown-results', 'no-response', 'no-summary', 'no-project-icon', 'unknown-avatar', 'restored']) {
  const run = runs[label], report = read('projection-' + label + '.json'), loaded = read('projection-' + label + '-loaded.json')
  assert.equal(report.numTotalTests, 5); assert.equal(Object.keys(loaded).length, 6); assert.equal(run.loadedModules, 6)
  for (const [name, actual] of Object.entries(loaded)) assert.equal(actual.before, inputs[name], name)
  if (label === 'candidate' || label === 'restored') { assert.equal(run.exitCode, 0); assert.equal(report.numPassedTests, 5); assert.equal(report.numFailedTests, 0) }
  else { assert.notEqual(run.exitCode, 0); assert.ok(report.numFailedTests > 0); assert.ok(run.failures.length > 0); assert.ok(run.failures.every(f => f.first.startsWith('AssertionError:'))) }
 }
 const types = read('projection-types.json'); assert.equal(types.production.exitCode, 0); assert.equal(types.owning.exitCode, 0)
 const callers = read('projection-callers.json'); assert.ok(Object.keys(callers).length > 0)
 for (const caller of Object.values(callers)) { assert.ok(caller.hits.length > 0); assert.ok(caller.hits.every(hit => !hit.startsWith(caller.definition + ':'))) }
 return receipt
}
function verifyLanes() {
 const receipt = read('lanes-qualification.json')
 assert.equal(receipt.feature, 'f-2eq8fwvcm'); assert.equal(receipt.scope, 'lanes'); assert.equal(receipt.installed, false)
 execFileSync('git', ['merge-base', '--is-ancestor', receipt.commit, 'main'], { cwd: root })
 for (const [name, expected] of Object.entries(receipt.inputs)) assert.equal(hash(execFileSync('git', ['show', receipt.commit + ':' + name], { cwd: root })), expected, name)
 assert.ok(Object.keys(receipt.inputs).length >= 9)
 const visual = read('visual-qualification.json'); assert.equal(visual.sourceCssSha256, receipt.inputs['apps/desktop/src/renderer/src/styles/focus.css'])
 assert.ok(visual.widths.length >= 3); assert.ok(visual.bounds.length > 0); assert.equal(visual.actualGeometryPassed, true); assert.equal(visual.personallyReviewed, true)
 assert.ok(visual.mutants.length >= 2); assert.ok(visual.mutants.every(m => m.assertionRed === true && m.restoredGreen === true && m.error.name === 'AssertionError'))
 const geometry = read('visual-execution.json'), build = read('visual-build.json')
 assert.equal(build.sourceCssSha256, visual.sourceCssSha256); assert.equal(Object.keys(build.loadedSourceInputs).length, 7)
 for (const [name, actual] of Object.entries(build.loadedSourceInputs)) assert.equal(actual, receipt.inputs[name], name)
 assert.deepEqual(geometry.widths, [1600, 1000, 320]); assert.equal(geometry.actualGeometryPassed, true)
 assert.ok(geometry.bounds.length === 3 && geometry.bounds.every(b => b.geometry.cards.length > 0 && b.geometry.heads.length === 4))
 for (const mutant of geometry.mutants) {
  assert.equal(build.variants[mutant.label].originalOccurrences, 1)
  assert.equal(mutant.error.name, 'AssertionError'); assert.equal(mutant.restoredGreen, true)
  assert.ok(mutant.geometry.css.some(url => url.endsWith('/' + mutant.label + '.css')))
 }
 for (const [name, expected] of Object.entries(visual.artifacts)) assert.equal(hash(readFileSync(resolve(proof, name))), expected, name)
 const runs = read('lanes-execution.json'); assert.ok(runs.candidate.passed > 0); assert.equal(runs.candidate.exitCode, 0); assert.equal(runs.restored.exitCode, 0)
 assert.notEqual(runs.original.exitCode, 0); assert.ok(runs.original.assertionFailures > 0)
 assert.ok(runs.mutants.length > 0); assert.ok(runs.mutants.every(m => m.exitCode !== 0 && m.assertionFailures > 0))
 for (const run of [runs.candidate, ...runs.mutants, runs.restored]) {
  const report = read('lanes-' + run.label + '.json'), loaded = read('lanes-' + run.label + '-loaded.json')
  assert.equal(report.numTotalTests, 10); assert.equal(Object.keys(loaded).length, 8)
  for (const [name, actual] of Object.entries(loaded)) assert.equal(actual.before, receipt.inputs[name], name)
  assert.equal(report.numFailedTests, run.failed); assert.equal(report.numPassedTests, run.passed)
 }
 const types = read('lanes-types.json'); assert.equal(types.production.exitCode, 0); assert.equal(types.owning.exitCode, 0)
 for (const typeRun of Object.values(types)) { assert.ok(Object.keys(typeRun.inputHashes).length > 0); for (const [name, actual] of Object.entries(typeRun.inputHashes)) assert.equal(actual, receipt.inputs[name], name) }
 const callers = read('lanes-callers.json'); assert.ok(Object.keys(callers).length > 0)
 for (const caller of Object.values(callers)) { assert.ok(caller.hits.length > 0); assert.ok(caller.hits.every(hit => !hit.startsWith(caller.definition + ':'))) }
 return receipt
}
const result = slice === 'projection' ? verifyProjection() : slice === 'lanes' ? verifyLanes() : { projection: verifyProjection(), lanes: verifyLanes() }
console.log(JSON.stringify({ result: 'PASS', slice, qualified: result, boundary: 'Focus lane information Source only; no installed/Runtime/full Focus/competitor claim.' }))
