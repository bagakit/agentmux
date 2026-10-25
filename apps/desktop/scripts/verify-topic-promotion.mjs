import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, relative } from 'node:path'

// Closeout consumes the original proofs; it never reruns a build, GUI or mutation.
assert.deepEqual(process.argv.slice(2), ['--consume'], 'Run the owning probes explicitly, then consume their candidate-bound receipts.')
const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.tmp/topic-promotion')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function checkSources(sources, label) {
  assert.ok(Object.keys(sources).length > 0, label + ' has original production inputs')
  for (const [file, digest] of Object.entries(sources)) assert.equal(hash(await readFile(resolve(root, file))), digest, label + ': changed input ' + file)
}
const backend = await json(join(evidence, 'backend-receipt.json'))
assert.equal(backend.passed, true)
assert.equal(backend.results.find(result => result.name === 'baseline')?.code, 0)
assert.ok(backend.results.some(result => result.mutation), 'The owner has meaningful source mutations')
for (const result of backend.results.filter(result => result.mutation)) assert.notEqual(result.code, 0)
await checkSources(backend.sourceDigests, 'Owner / CLI / restart')
const visualPath = (await json(join(evidence, 'latest-visual.json'))).evidence
const consumerPath = (await json(join(evidence, 'latest-consumer.json'))).evidence
const visual = await json(join(visualPath, 'receipt.json')), consumer = await json(join(consumerPath, 'receipt.json'))
assert.equal(visual.passed, true); assert.equal(visual.actual.passed, true)
assert.equal(consumer.passed, true); assert.equal(consumer.assertionRed, true)
assert.ok(visual.frames.length > 0); assert.equal(consumer.mutations.length, 1)
await checkSources(visual.inputs, 'Renderer')
// The menu mutation proves executable consumer wiring; the independently reviewed
// baseline above owns CSS/image presentation, including a later crop-only correction.
await checkSources(Object.fromEntries(Object.entries(consumer.inputs).filter(([file]) => !/\.(css|png|jpg|webp|svg)$/u.test(file))), 'Consumer mutation')
for (const frame of visual.frames) assert.equal(hash(await readFile(join(visualPath, frame.file))), frame.sha256, 'Original full screenshot ' + frame.file)
for (const file of ['code-review.md', 'visual-review.md']) {
  const review = await readFile(join(evidence, file), 'utf8')
  assert.match(review, /(?:Result|结论):\s*approved/u, 'Independent review explicitly approves: ' + file)
  if (file === 'visual-review.md') assert.ok(review.includes(relative(root, visualPath)), 'Review names the original full screenshot candidate')
}
console.log('Topic promotion: original owner, CLI, restart, mutation and independently reviewed Renderer receipts match this candidate.')
