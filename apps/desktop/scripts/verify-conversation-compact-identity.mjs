import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const root = path.resolve(import.meta.dirname, '../../..')
const argument = process.argv.indexOf('--proof')
assert.ok(argument > 0 && process.argv[argument + 1], '--proof required')
const resolve = file => path.resolve(root, file)
const read = file => JSON.parse(fs.readFileSync(resolve(file), 'utf8'))
const hash = file => createHash('sha256').update(fs.readFileSync(resolve(file))).digest('hex')
const proof = read(process.argv[argument + 1])
assert.equal(proof.schema, 'agentmux.compact-identity-source-qualification.v1')
assert.ok(Object.keys(proof.sources).length > 0)
for (const [file, sha] of Object.entries(proof.sources)) assert.equal(hash(file), sha, 'Exact owned Source ' + file)
function cases(file) {
  const report = read(file), tests = report.testResults.flatMap(result => result.assertionResults)
  assert.ok(tests.length > 0, 'Actual nonempty collection ' + file)
  return { report, tests, names: tests.map(test => test.fullName) }
}
const baseline = cases(proof.baseline), restored = cases(proof.restored), adjacent = cases(proof.adjacent)
for (const [value, count] of [[baseline, 6], [restored, 6], [adjacent, 32]]) {
  assert.equal(value.report.success, true); assert.equal(value.tests.length, count)
  assert.deepEqual(value.tests.map(test => test.status), Array(count).fill('passed'))
}
assert.deepEqual(restored.names, baseline.names)
const loaded = file => fs.readFileSync(resolve(file), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const actual = loaded(proof.baselineLoaded), exact = loaded(proof.restoredLoaded)
assert.ok(actual.length > 0)
assert.deepEqual(exact.map(input => [input.path, input.sha256]).sort(), actual.map(input => [input.path, input.sha256]).sort())
assert.equal(proof.mutants.length, 4)
for (const mutant of proof.mutants) {
  const receipt = read(mutant.receipt), value = cases(receipt.report), failed = value.tests.filter(test => test.status === 'failed')
  assert.equal(receipt.exitCode, 1); assert.equal(receipt.classification, 'AssertionRED')
  assert.deepEqual(value.names, baseline.names); assert.equal(failed.length, mutant.failed)
  assert.ok(failed.length > 0)
  for (const failure of failed) assert.ok(failure.failureMessages.some(message => message.includes('AssertionError')))
  const changed = loaded(receipt.loaded).filter(input => input.mutation === mutant.name)
  assert.equal(changed.length, 1); assert.equal(changed[0].originalSHA256, proof.sources[changed[0].path])
  assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
}
assert.equal(proof.types.length, 2)
for (const file of proof.types) {
  const receipt = read(file); assert.equal(receipt.exitCode, 0); assert.equal(receipt.cwd, root)
  assert.ok(receipt.argv.includes('--noEmit') && receipt.argv.includes('-p')); assert.ok(fs.existsSync(resolve(receipt.log)))
}
const callers = read(proof.callers).callers
assert.ok(callers.length > 0)
for (const caller of callers) assert.ok(caller.productionNonDefinitionMatches.some(match =>
  !match.startsWith(caller.excludedDefinition + ':') && !match.includes('/test/') && !match.includes('/fixtures/') && !match.includes(':import ')))
const compiled = read(proof.compiled), actions = read(proof.actions), sourceReview = read(proof.sourceReview), visual = read(proof.visualReview)
assert.ok(compiled.loaded.length > 0); assert.equal(actions.scenes.length, 2)
for (const file of proof.compiledSources) assert.ok(compiled.loaded.some(input => input.path === file && input.sha256 === proof.sources[file] && input.bytes > 0))
for (const asset of ['entry.js', 'entry.css']) assert.equal(hash(proof.compiledDirectory + '/' + asset), compiled.assets[asset])
for (const [index, scene] of actions.scenes.entries()) {
  assert.equal(Math.round(scene.width), index === 0 ? 1000 : 332); assert.equal(scene.sameIds.length, 5)
  assert.ok(scene.bodyWidths.length > 0 && scene.bodyWidths.every(width => width > 200))
  assert.equal(scene.sameBody, true); assert.equal(scene.rangeConnected, true); assert.equal(scene.rangeQuote, scene.originalQuote)
  assert.equal(scene.toolOpen, 'true'); assert.equal(scene.reasoningOpen, true); assert.deepEqual(scene.controls, [])
  assert.ok(scene.copies.length > 0); assert.equal(scene.draft, 'Keep the original unsent reply draft.')
}
assert.equal(actions.copyFailure.text, 'Copy failed'); assert.deepEqual(actions.reloaded.ids, actions.scenes[0].sameIds)
assert.equal(sourceReview.verdict, 'approved'); assert.ok(sourceReview.sources.length > 0)
for (const source of sourceReview.sources) assert.equal(source.sha256, proof.sources[source.path])
assert.equal(visual.passed, true); assert.ok(visual.reviewer && visual.reviewer !== '/root')
assert.equal(visual.sourceReceiptSHA256, hash(proof.compiled)); assert.equal(visual.actionsConsumed.sha256, hash(proof.actions))
assert.equal(visual.images.length, 7)
for (const image of visual.images) { assert.equal(image.passed, true); assert.equal(hash(image.path), image.sha256) }
console.log(JSON.stringify({ passed: true, owning: 6, adjacent: 32, mutations: 4, images: 7,
  boundary: proof.boundary, pendingConsumer: proof.pendingConsumer }, null, 2))
