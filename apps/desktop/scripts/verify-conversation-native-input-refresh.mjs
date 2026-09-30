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
assert.equal(proof.schema, 'agentmux.conversation-native-input-refresh-qualification.v1')
assert.ok(Object.keys(proof.sources).length >= 8, 'Nonempty owned Source inputs')
for (const [file, sha] of Object.entries(proof.sources)) assert.equal(hash(file), sha, 'Exact owned input ' + file)
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
assert.deepEqual(cases(proof.tests.restored).tests.map(test => test.fullName), baseline, 'Exact restored collection')
assert.equal(proof.mutants.length, 4)
for (const mutant of proof.mutants) {
  const { report, tests } = cases(mutant.report)
  assert.equal(report.success, false, mutant.name)
  assert.deepEqual(tests.map(test => test.fullName), baseline, 'Same collected cases ' + mutant.name)
  const failures = tests.filter(test => test.status === 'failed')
  assert.ok(failures.length > 0, 'Actual failed assertions ' + mutant.name)
  for (const failure of failures) assert.ok(failure.failureMessages.some(message => message.includes('AssertionError')), 'AssertionRED ' + mutant.name)
  const loaded = fs.readFileSync(resolve(mutant.loaded), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const changed = loaded.filter(item => item.mutation === mutant.name)
  assert.equal(changed.length, 1, 'One actual consumed product mutant ' + mutant.name)
  assert.equal(changed[0].originalSHA256, proof.sources[changed[0].path])
  assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
}
const loaded = fs.readFileSync(resolve(proof.loadedRestored), 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.ok(loaded.length > 0)
for (const file of proof.requiredLoaded) assert.ok(loaded.some(item => item.path === file && item.bytes > 0 && item.originalSHA256 === item.sha256 && item.sha256 === proof.sources[file]), 'Actually restored product input ' + file)
for (const type of proof.types) {
  assert.equal(fs.readFileSync(resolve(type.exit), 'utf8').trim(), '0', type.command)
  assert.ok(type.command.includes('--noEmit') || type.command.includes('typecheck'))
  assert.ok(fs.existsSync(resolve(type.log)))
}
assert.ok(proof.callers.length > 0, 'Nondefinition product callers')
for (const caller of proof.callers) {
  assert.notEqual(caller.path, caller.definition)
  assert.ok(!caller.path.includes('/test/'))
  assert.ok(fs.readFileSync(resolve(caller.path), 'utf8').includes(caller.call), 'Product call ' + caller.call)
}
const core = read(proof.coreSourceQualification)
assert.ok(core.status.startsWith('qualified-core-source-slice'))
assert.ok(core.mutants.length > 0)
for (const item of core.owningAndAdjacent) assert.equal(cases(item.path).report.success, true)
for (const item of core.mutants) {
  const { tests } = cases(item.report)
  const failed = tests.filter(test => test.status === 'failed')
  assert.ok(failed.length > 0)
  assert.ok(failed.some(test => test.failureMessages.some(message => message.includes('AssertionError'))))
}
for (const [file, sha] of Object.entries(proof.coreCurrentSources)) assert.equal(hash(file), sha, 'Current Core Source ' + file)
const fragment = proof.coreClientObserver
assert.equal(fragment.matchesPreviouslyQualifiedMethod, true)
const clientSource = fs.readFileSync(resolve(fragment.path), 'utf8')
const start = clientSource.indexOf(fragment.start), end = clientSource.indexOf(fragment.end, start)
assert.ok(start >= 0 && end > start, 'Nonempty exact current public observer method')
assert.equal(createHash('sha256').update(clientSource.slice(start, end)).digest('hex'), fragment.sha256)
assert.equal(hash(proof.publicCoreDist.path), proof.publicCoreDist.sha256)
function compiled(file, required) {
  const receipt = read(file)
  assert.ok(receipt.loaded.length > 0)
  for (const source of required) assert.ok(receipt.loaded.some(item => item.path === source && item.sha256 === proof.sources[source] && item.bytes > 0), 'Actually compiled product ' + source)
  return receipt
}
compiled(proof.compiled, proof.requiredCompiled)
compiled(proof.capturedCompiled, proof.requiredCapturedCompiled)
const actions = read(proof.actions), captured = read(proof.capturedActions)
assert.equal(actions.passed, true); assert.equal(captured.passed, true)
assert.deepEqual(actions.appended.ids, ['row-0', 'same-body-new', 'untimed-new'])
assert.equal(actions.appended.sameBody, true); assert.equal(actions.appended.rangeConnected, true)
assert.deepEqual(actions.appended.copies, ['Identical native body.'])
assert.equal(actions.appended.markers.length, 2); assert.equal(actions.appended.watchers, 1)
assert.equal(actions.records.ids.length, 3); assert.equal(actions.records.unknownTime, true)
assert.equal(actions.failure.ids.length, 3); assert.equal(actions.failure.sameBody, true)
assert.equal(actions.paused.sameBody, true); assert.equal(actions.returned.sameBody, true); assert.equal(actions.returned.rangeConnected, true)
assert.equal(Math.round(actions.narrow.width), 332); assert.equal(actions.narrow.records, 3); assert.equal(actions.narrow.unknownTime, true)
for (const state of [actions.appended, actions.failure, actions.paused, actions.returned, actions.narrow]) assert.equal(state.draft, 'Keep the original unsent reply draft.')
for (const state of [actions.appended, actions.returned, actions.narrow, captured.state]) assert.deepEqual(state.controls, [])
assert.deepEqual(captured.state.records.map(item => item.source), ['native', 'native', 'captured'])
assert.equal(new Set(captured.state.records.map(item => item.id)).size, 3)
assert.deepEqual(captured.state.timeline, [{ id: 'prompt:focus-native-captured', author: 'native-focus-b' }])
assert.deepEqual(captured.state.reads, ['native-focus-a'])
function review(file, compiledFile, actionsFile, images) {
  const receipt = read(file)
  assert.equal(receipt.passed, true); assert.ok(receipt.reviewer)
  assert.equal(receipt.sourceReceiptSha256, hash(compiledFile))
  assert.equal(receipt.actionsConsumed.sha256, hash(actionsFile))
  assert.equal(receipt.images.length, images.length)
  assert.ok(images.length > 0)
  for (const image of images) assert.ok(receipt.images.some(item => item.path === image && item.sha256 === hash(image) && item.passed && item.observations), 'Actually independently viewed image ' + image)
}
review(proof.visualReview, proof.compiled, proof.actions, proof.images)
review(proof.capturedVisualReview, proof.capturedCompiled, proof.capturedActions, proof.capturedImages)
// A notification to the Focus owner alone does not close the product Consumer.
assert.ok(proof.focusNotice, 'Original Focus owner must consume observation failure and frozen-window facts before task closure')
execFileSync('git', ['merge-base', '--is-ancestor', proof.focusNotice.commit, 'HEAD'], { cwd: root })
for (const [file, sha] of Object.entries(proof.focusNotice.sources)) assert.equal(hash(file), sha)
assert.ok(Object.keys(proof.focusNotice.sources).length > 0)
const noticeTests = cases(proof.focusNotice.report)
assert.equal(noticeTests.report.success, true)
assert.ok(proof.focusNotice.testNames.length >= 2)
for (const title of proof.focusNotice.testNames) assert.ok(noticeTests.tests.some(test => test.fullName === title && test.status === 'passed'), 'Actual Focus notice assertion ' + title)
console.log(JSON.stringify({ passed: true, owning: baseline.length, mutants: proof.mutants.length, images: proof.images.length + proof.capturedImages.length, sourceCommit: proof.sourceCommit, focusNoticeCommit: proof.focusNotice.commit, scope: proof.scope }, null, 2))
