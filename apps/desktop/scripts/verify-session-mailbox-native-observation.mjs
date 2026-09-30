import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const argument = process.argv.indexOf('--proof')
assert.ok(argument > 0, '--proof required')
const resolve = file => path.resolve(root, file)
const read = file => JSON.parse(fs.readFileSync(resolve(file), 'utf8'))
const hash = file => createHash('sha256').update(fs.readFileSync(resolve(file))).digest('hex')
const proof = read(process.argv[argument + 1])
assert.equal(proof.schema, 'agentmux.session-mailbox-native-observation-qualification.v1')
assert.ok(Object.keys(proof.sources).length >= 8, 'Nonempty actual Source inputs')
for (const [file, sha] of Object.entries(proof.sources)) assert.equal(hash(file), sha, 'Current product/own input ' + file)
function cases(file) {
  const report = read(file), tests = report.testResults.flatMap(result => result.assertionResults)
  assert.ok(tests.length > 0, 'Nonempty actual collection ' + file)
  assert.equal(tests.length, report.numTotalTests)
  return { report, tests }
}
for (const file of Object.values(proof.tests)) {
  const { report, tests } = cases(file)
  assert.equal(report.success, true, file)
  assert.equal(tests.filter(test => test.status === 'passed').length, tests.length, file)
}
const baseline = cases(proof.tests.baseline).tests.map(test => test.fullName)
assert.equal(baseline.length, 5)
assert.deepEqual(cases(proof.tests.restored).tests.map(test => test.fullName), baseline)
assert.equal(proof.mutants.length, 3)
for (const mutant of proof.mutants) {
  const { report, tests } = cases(mutant.report)
  assert.equal(report.success, false, mutant.name)
  assert.deepEqual(tests.map(test => test.fullName), baseline, 'Same actual collection ' + mutant.name)
  const failures = tests.filter(test => test.status === 'failed')
  assert.ok(failures.length > 0, 'Actual failed assertions ' + mutant.name)
  for (const failure of failures) assert.ok(failure.failureMessages.some(message => message.includes('AssertionError')), 'AssertionRED ' + mutant.name)
  const loaded = fs.readFileSync(resolve(mutant.loaded), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const changed = loaded.filter(item => item.mutation === mutant.name)
  assert.equal(changed.length, 1, 'One actual loaded product mutant ' + mutant.name)
  assert.equal(changed[0].path, 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx')
  assert.equal(changed[0].originalSHA256, proof.sources[changed[0].path])
  assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
}
const restored = fs.readFileSync(resolve(proof.loadedRestored), 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.ok(restored.length > 0)
for (const file of proof.requiredLoaded) assert.ok(restored.some(item => item.path === file && item.bytes > 0 && item.originalSHA256 === item.sha256 && item.sha256 === proof.sources[file]), 'Actually restored product input ' + file)
for (const type of proof.types) {
  assert.equal(fs.readFileSync(resolve(type.exit), 'utf8').trim(), '0', type.command)
  assert.ok(type.command.includes('tsc') && type.command.includes('--project'))
  assert.ok(fs.existsSync(resolve(type.log)))
}
assert.ok(proof.callers.length > 0, 'Nondefinition product consumers')
for (const caller of proof.callers) {
  assert.notEqual(caller.path, caller.definition)
  assert.ok(!caller.path.includes('/test/'))
  assert.ok(fs.readFileSync(resolve(caller.path), 'utf8').includes(caller.call), 'Actual product caller ' + caller.call)
}
const compiled = read(proof.compiled)
assert.ok(compiled.loaded.length > 0)
for (const file of proof.requiredCompiled) assert.ok(compiled.loaded.some(item => item.path === file && item.bytes > 0 && item.sha256 === proof.sources[file]), 'Actual compiled product input ' + file)
for (const [file, sha] of Object.entries(compiled.assets)) assert.equal(hash(path.join(path.dirname(proof.compiled), 'compiled', file)), sha, 'Exact compiled asset ' + file)
const actions = read(proof.actions)
assert.equal(actions.passed, true)
assert.equal(actions.retained.reads, 3)
assert.equal(actions.retained.ids.length, 90)
assert.equal(new Set(actions.retained.ids).size, 90)
assert.equal(actions.retained.scroll, 15)
assert.deepEqual(actions.frozen.ids, actions.retained.ids)
assert.equal(actions.frozen.reads, 4)
assert.ok(actions.frozen.boundary.includes('This bounded reading window is kept.'))
assert.equal(actions.latest.reads, 5)
assert.equal(actions.latest.ids.length, 30)
assert.ok(actions.latest.ids.includes('native:native:claude:native-mailbox:outside-window'))
assert.ok(actions.latest.ids.includes('native:native:claude:native-mailbox:also-outside'))
assert.equal(actions.latest.unknownTime, true)
assert.ok(!actions.latest.buttons.includes('Read latest records'))
assert.ok(actions.failure.error.includes('Failed to read native conversation history'))
assert.ok(actions.unavailable.error.includes('Automatic native updates are unavailable'))
assert.equal(actions.unavailable.listeners, 0)
assert.equal(Math.round(actions.narrow.regionWidth), 332)
assert.ok(actions.narrow.panelWidth <= actions.narrow.regionWidth)
for (const state of [actions.retained, actions.frozen, actions.failure, actions.unavailable, actions.narrow]) {
  assert.equal(state.sameBody, true)
  assert.equal(state.rangeConnected, true)
  assert.equal(state.rangeText, 'Same native body.')
}
for (const state of [actions.retained, actions.frozen, actions.latest, actions.failure, actions.unavailable, actions.narrow]) {
  assert.equal(state.draft, 'Keep the original unsent reply draft.')
  assert.deepEqual(state.controls, [])
}
const review = read(proof.visualReview)
assert.equal(review.passed, true)
assert.ok(review.reviewer)
assert.equal(review.sourceReceiptSha256, hash(proof.compiled))
assert.equal(review.actionsConsumed.sha256, hash(proof.actions))
assert.ok(proof.images.length > 0)
assert.equal(review.images.length, proof.images.length)
for (const image of proof.images) assert.ok(review.images.some(item => item.path === image && item.sha256 === hash(image) && item.passed && item.observations), 'Independently viewed original image ' + image)
if (proof.sourceCommit) execFileSync('git', ['merge-base', '--is-ancestor', proof.sourceCommit, 'HEAD'], { cwd: root })
console.log(JSON.stringify({ passed: true, owning: baseline.length, mutants: proof.mutants.length, images: proof.images.length, sourceCommit: proof.sourceCommit, scope: proof.scope }, null, 2))
