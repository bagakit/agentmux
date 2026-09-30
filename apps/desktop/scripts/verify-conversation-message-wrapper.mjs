import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const root = path.resolve(import.meta.dirname, '../../..')
const argument = process.argv.indexOf('--proof')
assert.ok(argument > 0 && process.argv[argument + 1], '--proof required')
const resolve = file => path.resolve(root, file)
const text = file => fs.readFileSync(resolve(file), 'utf8')
const read = file => JSON.parse(text(file))
const hash = file => createHash('sha256').update(fs.readFileSync(resolve(file))).digest('hex')
const proof = read(process.argv[argument + 1])
assert.equal(proof.schema, 'agentmux.conversation-message-wrapper-qualification.v1')
assert.ok(Object.keys(proof.sources).length > 0, 'Nonempty owned source inputs')
for (const [file, sha] of Object.entries(proof.sources)) {
  assert.ok(fs.statSync(resolve(file)).size > 0, file)
  assert.equal(hash(file), sha, 'Exact owned input ' + file)
}
assert.ok(Object.keys(proof.artifacts).length > 0, 'Nonempty evidence inputs')
for (const [file, sha] of Object.entries(proof.artifacts)) assert.equal(hash(file), sha, 'Exact evidence ' + file)
const config = text(proof.owningConfig)
assert.ok(config.includes("include: ['apps/desktop/test/conversation-message-wrapper.integration.test.tsx']"))
assert.ok(config.includes('passWithNoTests: false'))
function cases(file) {
  const report = read(file), tests = report.testResults.flatMap(result => result.assertionResults)
  assert.ok(tests.length > 0, 'Nonempty collected ' + file)
  return { report, tests }
}
for (const test of proof.tests) {
  const { report, tests } = cases(test.report)
  assert.equal(report.success, true, test.report)
  assert.equal(tests.length, test.count, test.report)
  assert.equal(tests.filter(item => item.status === 'passed').length, tests.length, test.report)
}
const names = file => cases(file).tests.map(test => test.fullName)
assert.deepEqual(names(proof.restored), names(proof.baseline), 'Exact restored collection')
const loaded = file => {
  const rows = text(file).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(rows.length > 0, 'Nonempty actual loaded inputs ' + file)
  return rows
}
assert.ok(proof.requiredLoaded.length >= 4)
const baselineLoaded = loaded(proof.loadedBaseline), restoredLoaded = loaded(proof.loadedRestored)
for (const file of proof.requiredLoaded) assert.ok(baselineLoaded.some(item => item.path === file && item.bytes > 0), 'Actual product caller ' + file)
assert.deepEqual(restoredLoaded, baselineLoaded, 'Exact restored loaded inputs')
assert.equal(proof.mutants.length, 5)
for (const mutant of proof.mutants) {
  const { report, tests } = cases(mutant.report), failures = tests.filter(test => test.status === 'failed')
  assert.equal(report.success, false, mutant.name)
  assert.deepEqual(tests.map(test => test.fullName), names(proof.baseline), 'Exact mutant collection ' + mutant.name)
  assert.equal(failures.length, mutant.failed, mutant.name)
  assert.ok(failures.length > 0, 'Semantic failure ' + mutant.name)
  for (const failure of failures) assert.ok(failure.failureMessages.some(message => message.includes('AssertionError')), 'Actual AssertionRED ' + mutant.name)
  const changed = loaded(mutant.loaded).filter(item => item.mutation === mutant.name)
  assert.equal(changed.length, 1, 'One actual loaded Message mutation ' + mutant.name)
  assert.equal(changed[0].path, proof.messageSource)
  assert.equal(changed[0].originalSHA256, proof.sources[proof.messageSource], 'Exact Message input ' + mutant.name)
  assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
}
assert.ok(proof.types.length > 0)
for (const file of proof.types) {
  const result = read(file)
  assert.equal(result.exitCode, 0, file)
  assert.equal(result.cwd, root)
  assert.ok(result.argv.includes('--noEmit') && result.argv.includes('-p'), 'Actual type argv ' + file)
  assert.ok(fs.existsSync(resolve(result.log)), 'Retained type log ' + file)
}
assert.ok(proof.callers.length > 0, 'Nonempty production callers')
for (const caller of proof.callers) {
  assert.notEqual(caller.path, caller.definition)
  assert.ok(!caller.path.includes('/test/') && !caller.path.includes('/fixtures/'))
  assert.ok(text(caller.path).includes(caller.call), 'Nondefinition product caller ' + caller.path)
}
const compiled = read(proof.compiled)
assert.ok(compiled.loaded.length > 0)
assert.ok(proof.requiredCompiled.length > 0, 'Nonempty compiled product selectors')
for (const file of proof.requiredCompiled) assert.ok(compiled.loaded.some(item => item.path === file && item.sha256 === proof.sources[file] && item.bytes > 0), 'Exact compiled product ' + file)
for (const asset of ['entry.js', 'entry.css']) assert.equal(hash(proof.compiledDirectory + '/' + asset), compiled.assets[asset])
const page = read(proof.publicPage), actions = read(proof.actions)
assert.equal(page.items.length, 5, 'Real public reader records')
assert.equal(actions.scenes.length, 2)
for (const [index, scene] of actions.scenes.entries()) {
  assert.equal(Math.round(scene.width), index === 0 ? 1000 : 332)
  assert.deepEqual(scene.ids, page.items.map(item => item.id))
  assert.equal(scene.rawCopy, page.items[0].contentParts.map(part => part.text).join('\n'), 'Raw original packet copy')
  assert.deepEqual(scene.citations, ['User', 'User', 'User'])
  assert.equal(scene.peerName, 'Review Agent')
  assert.equal(scene.draft, 'Keep the original reply draft.')
  assert.deepEqual(scene.controls, [])
}
const sourceReview = read(proof.sourceReview), visual = read(proof.visualReview)
assert.equal(sourceReview.verdict, 'approved')
assert.ok(sourceReview.sources.length > 0)
for (const source of sourceReview.sources) assert.equal(source.sha256, proof.sources[source.path], 'Reviewed exact source ' + source.path)
assert.equal(visual.passed, true)
assert.ok(visual.reviewer && visual.reviewer !== proof.implementationOwner, 'Independent reviewer')
assert.equal(visual.sourceReceiptSha256, hash(proof.compiled))
assert.equal(visual.actionsConsumed.sha256, hash(proof.actions))
assert.equal(visual.images.length, 6)
for (const image of visual.images) {
  assert.equal(image.passed, true)
  assert.equal(hash(image.path), image.sha256, 'Actually viewed final image ' + image.path)
  assert.ok(fs.statSync(resolve(image.path)).size > 0)
}
console.log(JSON.stringify({ passed: true, owning: 8, adjacent: 24, mutants: proof.mutants.length, images: visual.images.length, loadedInputs: baselineLoaded.length, scope: proof.scope }, null, 2))
