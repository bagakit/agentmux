import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

// Consume the bounded original-owner proof; this command never starts an
// Agent, reads credentials, packages the app or operates a user's work surface.
const root = path.resolve(import.meta.dirname, '../../..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function artifact(ref) {
  assert.ok(ref?.path && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ''))
  const bytes = await fs.readFile(path.resolve(root, ref.path))
  assert.equal(hash(bytes), ref.sha256, 'Evidence changed: ' + ref.path)
  return JSON.parse(bytes)
}
const locator = JSON.parse(await fs.readFile(path.resolve(root,
  process.env.AGENTMUX_MOTE_DIRECTORY_QUALIFICATION ?? '.tmp/mote-collaborator-directory/approved.json'), 'utf8'))
const proof = await artifact(locator.proof), review = await artifact(locator.review)
assert.equal(proof.schema, 'agentmux.mote-directory.qualification.v1')
assert.equal(proof.passed, true)
assert.equal(proof.taskId, 'T-001')
assert.equal(proof.modelInputs, 0)
assert.equal(proof.nativeRuns, 0)
assert.equal(proof.authRead, false)
assert.equal(review.approved, true)
assert.equal(review.proof.sha256, locator.proof.sha256)
const manifest = await artifact(proof.manifest)
assert.ok(proof.productPaths.length > 0)
assert.equal(new Set(proof.productPaths).size, proof.productPaths.length)
assert.deepEqual(Object.keys(manifest.files).sort(), [...proof.productPaths].sort())
for (const [file, sha] of Object.entries(manifest.files)) {
  assert.equal(hash(await fs.readFile(path.resolve(root, file))), sha,
    'Current owning product changed: ' + file)
}
const tests = await artifact(proof.tests), types = await artifact(proof.types), mutations = await artifact(proof.mutations)
assert.equal(tests.success, true)
assert.ok(tests.numTotalTests >= 44)
assert.equal(tests.numTotalTests, tests.numPassedTests)
assert.equal(types.passed, true)
assert.equal(types.strict, true)
assert.deepEqual(types.newDiagnostics, [])
assert.ok(!types.candidateDiagnostics.some(row => proof.productPaths.includes(row.file)))
assert.equal(mutations.passed, true)
assert.ok(mutations.cases.length >= 4)
for (const mutant of mutations.cases) {
  const raw = await artifact(mutant.tests), loaded = await artifact(mutant.loaded)
  assert.notEqual(mutant.exitCode, 0)
  assert.ok(raw.numFailedTests > 0)
  assert.equal(mutant.assertionRed, true)
  assert.notEqual(mutant.beforeSha256, mutant.afterSha256)
  assert.equal(loaded[mutant.file], mutant.afterSha256)
}
const restored = await artifact(mutations.restored.tests), loaded = await artifact(mutations.restored.loaded)
assert.equal(restored.success, true)
assert.equal(restored.numPassedTests, restored.numTotalTests)
assert.equal(restored.numTotalTests, tests.numTotalTests)
const renderer = await artifact(proof.renderer), visual = await artifact(proof.visual)
assert.equal(renderer.passed, true)
assert.equal(renderer.renderer.passed, true)
assert.ok(renderer.renderer.originalInteractions.settingsRadioAndSave)
assert.ok(renderer.renderer.originalInteractions.originalObjectMenu)
assert.equal(visual.approved, true)
assert.equal(visual.renderer.sha256, proof.renderer.sha256)
assert.ok(Object.keys(renderer.images).length >= 12)
assert.equal(Object.keys(visual.images).length, Object.keys(renderer.images).length)
for (const [file, sha] of Object.entries(renderer.images)) {
  assert.equal(hash(await fs.readFile(path.resolve(root, file))), sha)
  assert.equal(visual.images[file], sha)
}
assert.ok(proof.callers.length > 0)
assert.ok(Object.keys(proof.source).length > 0)
for (const [file, sha] of Object.entries(proof.source)) {
  const bytes = execFileSync('git', ['show', proof.candidate + ':' + file], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(hash(bytes), sha, 'Qualified Source changed: ' + file)
}
for (const [file, sha] of Object.entries(loaded)) if (file.includes('/src/')) assert.equal(proof.source[file], sha)
for (const [file, sha] of Object.entries(types.source)) assert.equal(proof.source[file], sha)
for (const caller of proof.callers) {
  assert.notEqual(caller.definition, caller.file)
  assert.ok(proof.source[caller.file])
  const bytes = execFileSync('git', ['show', proof.candidate + ':' + caller.file], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
  assert.ok(bytes.toString().includes(caller.anchor))
}
console.log(JSON.stringify({ passed: true, taskId: proof.taskId, tests: tests.numPassedTests,
  mutants: mutations.cases.length, affectedTypeErrors: 0, images: Object.keys(renderer.images).length,
  modelInputs: 0, proof: locator.proof, review: locator.review }))
