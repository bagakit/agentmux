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
assert.equal(proof.schema, 'agentmux.declared-context-spacing-source-qualification.v1')
assert.ok(Object.keys(proof.sources).length >= 5, 'Nonempty actual owned Source')
for (const [file, sha] of Object.entries(proof.sources)) assert.equal(hash(file), sha, 'Exact Source ' + file)
function cases(file, successful) {
  const report = read(file), tests = report.testResults.flatMap(result => result.assertionResults)
  assert.equal(tests.length, 4); assert.equal(report.numTotalTests, 4); assert.equal(report.success, successful)
  if (successful) assert.deepEqual(tests.map(test => test.status), Array(4).fill('passed'))
  return tests
}
const inputs = file => fs.readFileSync(resolve(file), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const qualification = read(proof.loadedQualification), dir = path.dirname(proof.loadedQualification)
assert.equal(qualification.passed, true)
const baseline = cases(path.join(dir, qualification.baseline.tests), true), names = baseline.map(test => test.fullName)
const baselineInputs = inputs(path.join(dir, qualification.baseline.loaded)); assert.ok(baselineInputs.length > 0)
const originalInputs = baselineInputs.map(input => [input.path, input.sha256]).sort()
assert.equal(qualification.rounds.length, 6)
assert.deepEqual(qualification.rounds.filter(round => round.mutation).map(round => round.mutation), proof.mutations)
assert.equal(proof.mutations.length, 3)
for (const round of qualification.rounds) {
  const tests = cases(path.join(dir, round.tests), !round.mutation)
  assert.deepEqual(tests.map(test => test.fullName), names, 'Same actual collection ' + round.label)
  assert.equal(read(path.join(dir, round.command)).code, round.mutation ? 1 : 0)
  const loaded = inputs(path.join(dir, round.loaded)); assert.ok(loaded.length > 0)
  if (round.mutation) {
    const failed = tests.filter(test => test.status === 'failed')
    assert.ok(failed.length > 0); assert.equal(failed.length, round.failed)
    for (const test of failed) assert.ok(test.failureMessages.some(message => message.includes('AssertionError')), 'AssertionRED ' + round.mutation)
    const changed = loaded.filter(input => input.mutation === round.mutation)
    assert.equal(changed.length, 1); assert.equal(changed[0].originalSHA256, proof.sources[changed[0].path])
    assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
  } else assert.deepEqual(loaded.map(input => [input.path, input.sha256]).sort(), originalInputs, 'Exact restored loaded inputs')
}
for (const source of qualification.sourceAfter) assert.equal(source.sha256, proof.sources[source.path])
const typeCommand = read(proof.types)
assert.equal(typeCommand.code, 0); assert.equal(typeCommand.cwd, root); assert.ok(typeCommand.argv.includes('--noEmit'))
assert.equal(proof.coreBuilds, 0)
const binding = read(proof.coreBinding)
assert.ok(binding.files.length > 0)
for (const source of binding.files) assert.equal(hash(source.path), source.sha256, 'Unchanged public parser ' + source.path)
const callers = read(proof.callers)
assert.equal(callers.passed, true); assert.ok(callers.facts.length >= 2)
for (const fact of callers.facts) assert.ok(fact.hits.some(hit => hit.path !== fact.definitionExcluded &&
  hit.path.endsWith('.tsx') && !hit.path.includes('/test/') && new RegExp('<(?:Memoized)?' + fact.symbol + '(?=[\\s>]|$)', 'u').test(hit.text) &&
  fs.readFileSync(resolve(hit.path), 'utf8').includes(hit.text)), 'Product render outside definition ' + fact.symbol)
const compiled = read(proof.compiled); assert.ok(compiled.loaded.length > 0)
for (const file of proof.requiredCompiled) assert.ok(compiled.loaded.some(input => input.path === file && input.bytes > 0 && input.sha256 === hash(file)), 'Actually compiled product input ' + file)
for (const [file, sha] of Object.entries(compiled.assets)) assert.equal(hash(proof.compiledDirectory + '/' + file), sha)
const actions = read(proof.actions), scene = read(proof.scene)
assert.equal(actions.passed, true); assert.equal(actions.scenes.length, 2); assert.equal(scene.page.items.length, 3)
const scroll = actions.scrollProbe
assert.equal(scroll.passed, true); assert.ok(scroll.before.scrollTop > 0)
assert.ok(scroll.before.scrollHeight > scroll.before.clientHeight); assert.equal(scroll.before.records, 3)
assert.equal(scroll.after.scrollTop, scroll.before.scrollTop)
for (const key of ['sameRow', 'sameParagraph', 'rangeConnected']) assert.equal(scroll.after[key], true)
assert.equal(scroll.after.quote, scroll.before.quote); assert.equal(scroll.after.draft, scroll.after.originalDraft)
assert.deepEqual(scroll.after.controls, [])
for (const [index, state] of actions.scenes.entries()) {
  assert.equal(Math.round(state.width), index === 0 ? 1000 : 332)
  const geometry = state.geometry
  assert.ok(geometry.summaryCount > 0); assert.equal(geometry.paragraphCount, 1); assert.equal(geometry.text, 'Clarify goal')
  assert.ok(geometry.glyphHeight > 0); assert.ok(geometry.lineHeight > 0)
  assert.ok(geometry.gap >= 0 && geometry.gap <= geometry.lineHeight + 1)
  assert.equal(geometry.marginTop, '0px'); assert.equal(geometry.marginBottom, '0px')
  assert.deepEqual(state.ids, scene.page.items.map(item => item.id)); assert.deepEqual(state.sameRows, [true, true, true])
  for (const key of ['sameBody', 'sameParagraph', 'rangeConnected', 'rerendered']) assert.equal(state[key], true)
  assert.equal(state.rangeQuote, 'Clarify goal'); assert.equal(state.rangeQuote, state.originalQuote); assert.equal(state.draft, scene.draft)
  if (index === 0) assert.equal(state.scrollTop, state.preservedScrollTop)
  assert.deepEqual(state.controls, []); assert.deepEqual(state.headers, ['You', 'You', 'You'])
  assert.ok(state.bodyWidths.length > 0 && state.bodyWidths.every(width => width > 200))
  assert.equal(state.opened.open, true); assert.equal(state.opened.selectedRaw, state.opened.raw)
  assert.ok(state.opened.raw.startsWith('<amux from="amux">'))
  assert.deepEqual(state.copies, scene.page.items.map(item => item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('\n')))
}
const sourceReview = read(proof.sourceReview), visual = read(proof.visualReview)
assert.equal(sourceReview.verdict, 'approved'); assert.ok(sourceReview.sources.length >= 2)
for (const source of sourceReview.sources) assert.equal(source.sha256, hash(source.path))
assert.equal(visual.passed, true); assert.ok(visual.reviewer && visual.reviewer !== '/root')
assert.equal(visual.sourceReceiptSha256, hash(proof.compiled)); assert.equal(visual.actionsConsumed.sha256, hash(proof.actions))
assert.equal(visual.images.length, 2)
for (const image of visual.images) { assert.equal(image.passed, true); assert.equal(hash(image.path), image.sha256); assert.ok(image.observations) }
console.log(JSON.stringify({ passed: true, owning: 4, mutations: 3, images: 2, gaps: actions.scenes.map(scene => scene.geometry.gap), coreBuilds: 0, boundary: proof.boundary }, null, 2))
