import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const [mode, proofRef] = process.argv.slice(2)
assert.ok(mode === 'manual' || mode === 'tree', 'Expected manual or tree')
assert.ok(proofRef, 'Expected this Task’s proof.json')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const proof = await readJson(path.resolve(root, proofRef))
assert.equal(proof.schema, 'agentmux.space-identity-hierarchy-proof.v1')
assert.equal(proof.task, mode === 'manual' ? 'T-001' : 'T-002')

async function verifyHash(base, relative, expected) {
  assert.match(expected, /^[a-f0-9]{64}$/, `Missing SHA256: ${relative}`)
  const file = path.resolve(base, relative)
  assert.ok(file.startsWith(root + path.sep), `Evidence leaves the candidate workspace: ${file}`)
  assert.equal(digest(await fs.readFile(file)), expected, `Changed bytes: ${file}`)
}
async function verifyFiles(base, files, name) {
  assert.ok(files && typeof files === 'object' && !Array.isArray(files), `Missing ${name}`)
  const entries = Object.entries(files)
  assert.ok(entries.length > 0, `${name} is empty`)
  for (const [file, sha] of entries) await verifyHash(base, file, sha)
  return entries.length
}

const receiptFile = path.resolve(root, proof.nativeReceipt)
const receipt = await readJson(receiptFile)
const receiptDirectory = path.dirname(receiptFile)
assert.equal(receipt.schema, mode === 'manual' ? 'agentmux.space-object-appearance-native.v1' : 'agentmux.space-tree-alignment-native.v2')
assert.equal(receipt.passed, true)
assert.equal(receipt.captureOnly, true)
assert.equal(receipt.aestheticReview, 'not-performed')
assert.match(receipt.candidate.commit, /^[a-f0-9]{40}$/)
execFileSync('git', ['merge-base', '--is-ancestor', receipt.candidate.commit, 'HEAD'], { cwd: root })
const inputCount = await verifyFiles(root, receipt.inputs, 'actual loaded inputs')
for (const suffix of ['/store.ts', '/WorkspaceSidebar.tsx', '/SpaceTopicsTree.tsx', '/space-object-appearance.ts']) {
  assert.ok(Object.keys(receipt.inputs).some(file => file.endsWith(suffix)), `Missing production consumer input: ${suffix}`)
}
assert.equal(receipt.compiledArtifacts.preserved, true)
assert.equal(receipt.compiledArtifacts.recordOnly, false)
assert.equal(receipt.compiledArtifacts.pathBase, 'receipt-directory')
const outputCount = await verifyFiles(receiptDirectory, receipt.compiledOutputs, 'preserved compiled outputs')
assert.ok(Array.isArray(receipt.phases) && receipt.phases.length >= (mode === 'manual' ? 3 : 2), 'Missing process generations')
const pids = receipt.phases.map(phase => {
  assert.equal(phase.exit.exitCode, 0)
  assert.equal(phase.exit.timedOut, false)
  assert.equal(phase.native.passed, true)
  assert.ok(Number.isInteger(phase.native.pid) && phase.native.pid > 0)
  assert.ok(phase.native.generation, 'Generation was not read in the process')
  assert.ok(Array.isArray(phase.native.operations) && phase.native.operations.length > 0, 'No actual UI operations')
  assert.ok(phase.native.workface, 'No retained workface observation')
  return phase.native.pid
})
assert.equal(new Set(pids).size, pids.length, 'Restart reused a process')
assert.deepEqual(receipt.cleanup.remaining, [])
assert.equal(receipt.cleanup.rootRemoved, true)
assert.ok(Array.isArray(receipt.images) && receipt.images.length > 0, 'No actual screenshots')
for (const shot of receipt.images) {
  assert.ok(pids.includes(shot.pid), 'Image has no real process provenance')
  assert.ok(shot.scene && shot.generation, 'Image has no scene or generation')
  await verifyHash(receiptDirectory, shot.file, shot.sha256)
}
if (mode === 'tree') {
  assert.ok(Array.isArray(receipt.matrix), 'Missing visual matrix')
  const expected = ['default', 'compact', 'dense'].flatMap(density => [180, 240].flatMap(width =>
    ['dark', 'light'].map(appearance => `${density}:${width}:${appearance}`))).sort()
  const actual = receipt.matrix.map(scene => `${scene.density}:${scene.width}:${scene.appearance}`).sort()
  assert.deepEqual(actual, expected, 'Visual matrix is incomplete')
}

const review = await readJson(path.resolve(root, proof.visualReview))
assert.equal(review.status, 'pass')
assert.ok(review.reviewer && review.reviewer !== '/root', 'An independent Agent must actually view the images')
assert.equal(review.nativeReceiptSha256, digest(await fs.readFile(receiptFile)))
assert.ok(Array.isArray(review.readImages) && review.readImages.length > 0, 'No independent image reads')
for (const shot of receipt.images) {
  assert.ok(review.readImages.some(read => read.file === shot.file && read.sha256 === shot.sha256), `Image was not independently read: ${shot.file}`)
}
assert.ok(review.findings?.length > 0, 'No concrete visual judgment')

assert.ok(Array.isArray(proof.mutations) && proof.mutations.length > 0, 'No causal mutations')
const requiredMutations = mode === 'manual'
  ? ['manual-priority', 'host-isolation', 'single-key-concurrency', 'failed-draft-retained', 'omitted-persist-field']
  : ['members-indent', 'group-glyph', 'folder-pin-region', 'small-pin-glyph', 'quiet-automatic-identities']
assert.deepEqual(proof.mutations.map(mutation => mutation.name).sort(), requiredMutations.sort(), 'Required causal behaviors are incomplete')
for (const mutation of proof.mutations) {
  assert.ok(mutation.name && mutation.productionPath.includes('/src/'), 'Mutation must break production behavior')
  assert.equal(mutation.originalSha256, mutation.restoredSha256, 'Mutation was not restored byte for byte')
  await verifyHash(root, mutation.productionPath, mutation.restoredSha256)
  assert.ok(Number.isInteger(mutation.red.exitCode) && mutation.red.exitCode !== 0, 'Mutation did not turn RED')
  assert.equal(mutation.green.exitCode, 0, 'Restored implementation is not GREEN')
  await verifyHash(root, mutation.red.log, mutation.red.sha256)
  await verifyHash(root, mutation.green.log, mutation.green.sha256)
}
assert.ok(Array.isArray(proof.callers) && proof.callers.length > 0, 'No product callers')
for (const caller of proof.callers) {
  assert.ok(caller.symbol && caller.definition && Array.isArray(caller.paths) && caller.paths.length > 0)
  for (const file of caller.paths) {
    assert.notEqual(file, caller.definition)
    assert.ok(file.includes('/src/') && !file.includes('/test/'), `Not a production caller: ${file}`)
    assert.ok((await fs.readFile(path.resolve(root, file), 'utf8')).includes(caller.symbol), `Missing outside-definition caller: ${caller.symbol} in ${file}`)
  }
}
console.log(JSON.stringify({ passed: true, task: proof.task, inputCount, outputCount, pids, images: receipt.images.length,
  mutations: proof.mutations.length, callers: proof.callers.length }))
