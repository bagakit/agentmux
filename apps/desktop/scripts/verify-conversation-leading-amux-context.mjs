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
assert.equal(proof.schema, 'agentmux.leading-amux-source-qualification.v1')
assert.ok(Object.keys(proof.sources).length >= 9, 'Nonempty actual owned Source')
for (const [file, sha] of Object.entries(proof.sources)) assert.equal(hash(file), sha, 'Exact Source ' + file)
const loaded = file => fs.readFileSync(resolve(file), 'utf8').trim().split('\n').map(line => JSON.parse(line))
function cases(file, successful, count) {
  const report = read(file), tests = report.testResults.flatMap(result => result.assertionResults)
  assert.ok(tests.length > 0, 'Nonempty actual collection ' + file)
  assert.equal(tests.length, count); assert.equal(report.numTotalTests, count); assert.equal(report.success, successful)
  if (successful) assert.deepEqual(tests.map(test => test.status), Array(count).fill('passed'))
  return tests
}
const qualification = read(proof.loadedQualification), dir = path.dirname(proof.loadedQualification)
assert.equal(qualification.passed, true)
const baseline = cases(path.join(dir, qualification.baseline.tests), true, 6)
const names = baseline.map(test => test.fullName)
const baselineLoaded = loaded(path.join(dir, qualification.baseline.loaded))
assert.ok(baselineLoaded.length > 0)
const originalInputs = baselineLoaded.map(input => [input.path, input.sha256]).sort()
assert.equal(qualification.rounds.length, 6)
assert.deepEqual(qualification.rounds.filter(round => round.mutation).map(round => round.mutation), ['swallow-tail', 'consume-indented-continuation', 'copy-body-only'])
for (const round of qualification.rounds) {
  const tests = cases(path.join(dir, round.tests), !round.mutation, 6)
  assert.deepEqual(tests.map(test => test.fullName), names, 'Same actual collection ' + round.label)
  const command = read(path.join(dir, round.command)), inputs = loaded(path.join(dir, round.loaded))
  assert.equal(command.code, round.mutation ? 1 : 0)
  if (round.mutation) {
    const failed = tests.filter(test => test.status === 'failed')
    assert.ok(failed.length > 0); assert.equal(failed.length, round.failed)
    for (const test of failed) assert.ok(test.failureMessages.some(message => message.includes('AssertionError')), 'AssertionRED ' + round.mutation)
    const changed = inputs.filter(input => input.mutation === round.mutation)
    assert.equal(changed.length, 1); assert.equal(changed[0].originalSHA256, proof.sources[changed[0].path])
    assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
  } else assert.deepEqual(inputs.map(input => [input.path, input.sha256]).sort(), originalInputs, 'Exact restored loaded inputs')
}
for (const source of qualification.sourceAfter) assert.equal(source.sha256, proof.sources[source.path])
cases(proof.adjacent, true, 8)
for (const file of [proof.types, proof.coreBuild]) {
  const command = read(file); assert.equal(command.code, 0); assert.equal(command.cwd, root)
  assert.ok(command.argv.length > 1)
}
assert.ok(read(proof.types).argv.includes('--noEmit'))
const binding = read(proof.coreBinding)
assert.equal(binding.declaredContextsExported, true); assert.ok(binding.files.length > 0)
for (const source of binding.files) assert.equal(hash(source.path), source.sha256)
const callers = read(proof.callers)
assert.equal(callers.passed, true); assert.ok(callers.facts.length > 0)
for (const fact of callers.facts) {
  assert.ok(fact.hits.some(hit => hit.path !== fact.definitionExcluded && !hit.path.includes('/test/') &&
    !hit.text.startsWith('import ') && fs.readFileSync(resolve(hit.path), 'utf8').includes(hit.text)), 'Product consumer outside definition ' + fact.symbol)
}
const compiled = read(proof.compiled)
assert.ok(compiled.loaded.length > 0)
for (const file of proof.requiredCompiled) assert.ok(compiled.loaded.some(input => input.path === file && input.bytes > 0 && input.sha256 === hash(file)), 'Actually compiled product input ' + file)
for (const [file, sha] of Object.entries(compiled.assets)) assert.equal(hash(proof.compiledDirectory + '/' + file), sha, 'Exact compiled input ' + file)
const actions = read(proof.actions), scene = read(proof.scene)
assert.equal(actions.passed, true); assert.equal(actions.scenes.length, 2); assert.equal(scene.page.items.length, 3)
for (const [index, state] of actions.scenes.entries()) {
  assert.equal(Math.round(state.width), index === 0 ? 1000 : 332)
  assert.deepEqual(state.ids, scene.page.items.map(item => item.id)); assert.deepEqual(state.sameRows, [true, true, true])
  assert.equal(state.sameBody, true); assert.equal(state.rangeConnected, true); assert.equal(state.rangeQuote, state.originalQuote)
  assert.equal(state.draft, scene.draft); assert.deepEqual(state.controls, [])
  assert.deepEqual(state.headers, ['You', 'You', 'You']); assert.deepEqual(state.declaredSourceLabels, [])
  assert.deepEqual(state.disclosures.map(blocks => blocks.length), [1, 2, 1])
  assert.equal(state.disclosures[0][0].open, false); assert.deepEqual(state.disclosures[1].map(block => block.open), [true, true])
  assert.equal(state.disclosures[2][0].open, false); assert.deepEqual(state.paragraphs[1], [])
  assert.equal(state.opened.open, true); assert.equal(state.opened.selectedRaw, state.opened.raw)
  assert.ok(state.opened.raw.includes('AgentMux runtime guide:'))
  assert.ok(state.bodyWidths.length > 0 && state.bodyWidths.every(width => width > 200))
  assert.deepEqual(state.copies.slice(0, 3), scene.page.items.map(item => item.contentParts[0].text))
  assert.equal(state.codes[0][0], 'const indentation = "four spaces"  ')
}
const sourceReview = read(proof.sourceReview), visual = read(proof.visualReview)
assert.equal(sourceReview.verdict, 'approved'); assert.ok(sourceReview.sources.length > 0)
for (const source of sourceReview.sources) assert.equal(source.sha256, hash(source.path))
assert.equal(visual.passed, true); assert.ok(visual.reviewer && visual.reviewer !== '/root')
assert.equal(visual.sourceReceiptSha256, hash(proof.compiled)); assert.equal(visual.actionsConsumed.sha256, hash(proof.actions))
assert.equal(visual.images.length, 2)
for (const image of visual.images) { assert.equal(image.passed, true); assert.equal(hash(image.path), image.sha256); assert.ok(image.observations) }
console.log(JSON.stringify({ passed: true, owning: 6, adjacent: 8, mutations: 3, images: 2, boundary: proof.boundary }, null, 2))
