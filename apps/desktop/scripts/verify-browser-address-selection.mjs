import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const git = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const argument = process.argv.slice(2)
assert.ok(argument.length === 0 || argument.length === 2 && argument[0] === '--proof', 'Use --proof FILE to verify a specific qualification')
const proofFile = argument.length ? resolve(argument[1]) : resolve(dirname(git), '.local/browser-address-selection/qualification.json')
const parse = bytes => JSON.parse(bytes.toString('utf8'))
const proof = parse(readFileSync(proofFile))
assert.equal(proof.schema, 'agentmux.browser-address-selection-qualification.v1')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const read = (file, expected) => {
  const bytes = readFileSync(file)
  assert.equal(digest(bytes), expected, 'Original evidence ' + file)
  return bytes
}
const reference = entry => resolve(dirname(proofFile), entry.path)
const load = entry => parse(read(reference(entry), entry.sha256))
const native = load(proof.native)
assert.equal(native.selectedCase, 'address-selection')
assert.equal(native.passed, true)
assert.equal(native.mutation, null)
assert.equal(native.phases.length, 1)
const phase = native.phases[0]
const output = dirname(reference(proof.native))
const first = parse(read(resolve(output, phase.receipt), phase.sha256))
assert.equal(first.businessPassed, true)
const test = first.cases.find(item => item.kind === 'address-selection-exact-navigation')
assert.ok(test?.passed && test.browserId)
assert.equal(test.events.length, 2)
assert.equal(test.events[0], test.suggestions[0])
assert.equal(new URL(test.events[0]).searchParams.get('keep'), 'a+b')
assert.equal(new URL(test.events[0]).hash, '#chapter')
assert.equal(new URL(test.events[1]).searchParams.get('q'), test.suggestions[1])
assert.ok(first.addressDetailsHeld && first.addressDetailsReleased)
assert.ok(first.addressProjection && first.addressProjection.contentsId !== first.addressProjection.guestId)
const inputs = [
  'apps/desktop/src/renderer/src/components/BrowserAddressInput.tsx',
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/lib/browser-address-suggestions.ts',
  'apps/desktop/scripts/fixtures/browser-profile-survey-workface/address-selection-case.ts'
]
for (const file of inputs) read(resolve(root, file), native.sources[file])
// These shared routers also hold unrelated Desktop capabilities. Bind the exact
// compiled file from the original candidate, then compare its one owning route.
assert.match(native.candidate, /^[0-9a-f]{40}$/u)
for (const [file, from, until] of [
  ['apps/desktop/src/main/ipc.ts', "handleWithEvent('browser:listInputHistory'", "handleWithEvent('browser:recordInputHistory'"],
  ['apps/desktop/src/preload/index.ts', '    listInputHistory:', '    recordInputHistory:']
]) {
  const original = execFileSync('git', ['show', `${native.candidate}:${file}`], { cwd: root })
  assert.equal(digest(original), native.sources[file], 'Compiled router input ' + file)
  const route = text => {
    const start = text.indexOf(from), end = text.indexOf(until, start + from.length)
    assert.ok(start >= 0 && end > start, 'Original address history route ' + file)
    return text.slice(start, end)
  }
  assert.equal(route(readFileSync(resolve(root, file), 'utf8')), route(original.toString('utf8')), 'Unchanged exact address history route ' + file)
}
const checks = {
  'delay-saved-addresses': /saved address is actionable before optional details return/,
  'submit-draft-instead-of-selected-address': /clicked saved address commits in the same original Browser/
}
for (const [mutation, failure] of Object.entries(checks)) {
  const mutant = load(proof.mutations[mutation])
  assert.equal(mutant.selectedCase, 'address-selection')
  assert.equal(mutant.passed, false)
  assert.equal(mutant.mutation.name, mutation)
  assert.match(mutant.failure.message, failure)
  assert.deepEqual(mutant.privateProcessesRemaining, [])
  assert.deepEqual(mutant.sourceDrift, [])
  const [source] = mutant.mutation.applied
  assert.equal(mutant.mutation.applied.length, 1)
  assert.equal(source.file, 'apps/desktop/src/renderer/src/components/BrowserAddressInput.tsx')
  assert.equal(source.originalSha256, native.sources[source.file])
  assert.notEqual(source.originalSha256, source.effectiveSha256)
}
assert.deepEqual(native.privateProcessesRemaining, [])
assert.deepEqual(native.sourceDrift, [])
assert.deepEqual(native.artifactDrift, [])

const review = load(proof.visualReview)
const file = 'first-address-selection-narrow.png'
const image = review.images.find(item => item.file === file)
assert.ok(review.passed && review.reviewer && image && first.frames.some(frame => frame.file === file))
read(resolve(output, file), image.sha256)
console.log('Browser address selection qualified: saved suggestions during a delayed read, exact pointer navigation, independent search and two rejected mutations.')
