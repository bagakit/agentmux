import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Consume completed, exact-source qualification without repeating live mutations
// because unrelated colleagues changed the shared checkout during Tracker's gate.
const root = resolve(import.meta.dirname, '../../..')
const receipt = 'docs/reviews/evidence/launcher-entry-polish-2026-10-04/source-receipt.json'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => readFile(resolve(root, path))
const proofBytes = await read(receipt)
const proof = JSON.parse(proofBytes)
assert.equal(proof.schema, 'agentmux.launcher-entry-polish-source.v1')
assert.equal(proof.status, 'passed')
assert.equal(proof.feature, 'f-2hm8f4ca7')
assert.ok(proof.sourceBindings.length > 0 && proof.testBindings.length > 0)
for (const binding of [...proof.sourceBindings, ...proof.testBindings, proof.verificationBinding]) {
  assert.equal(sha(await read(binding.path)), binding.sha256, `Qualification input changed: ${binding.path}`)
}
assert.equal(sha(JSON.stringify(proof.sourceBindings)), proof.sourceDigest)

async function report(record, red = false) {
  const result = JSON.parse(await read(record.report))
  assert.ok(result.numTotalTests > 0, 'Actual test collection must be nonempty')
  assert.equal(record.tests, result.numTotalTests)
  assert.equal(record.passed, result.numPassedTests)
  const failures = result.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed'))
  if (red) {
    assert.equal(record.exitCode, 1)
    assert.ok(failures.length > 0)
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Mutation must fail an assertion')
  } else {
    assert.equal(record.exitCode, 0)
    assert.ok(result.numPassedTests > 0)
    assert.equal(result.numFailedTests, 0)
    assert.equal(failures.length, 0)
  }
}
await report(proof.baseline)
await report(proof.restored)
assert.equal(proof.baseline.passed, proof.baseline.tests)
assert.equal(proof.restored.passed, proof.baseline.passed)
assert.equal(proof.mutations.length, 11)
assert.equal(new Set(proof.mutations.map(item => item.id)).size, proof.mutations.length)
for (const mutation of proof.mutations) {
  assert.equal(mutation.status, 'assertion-red-exact-restore-green')
  assert.notEqual(mutation.originalSha256, mutation.mutatedSha256)
  assert.equal(sha(await read(mutation.path)), mutation.originalSha256, `Mutation was not restored: ${mutation.id}`)
  await report(mutation.red, true)
  await report(mutation.restored)
}
assert.equal(proof.callers.length, 8)
for (const caller of proof.callers) {
  assert.ok(caller.uses.length > 0, `No product caller: ${caller.symbol}`)
  for (const use of caller.uses) {
    assert.notEqual(use.path, caller.definition)
    assert.ok(!use.path.includes('/test/'))
    assert.ok(use.use.trim().length > 0)
    assert.ok((await read(use.path)).toString().includes(use.use), `Actual caller changed: ${caller.symbol}`)
  }
}
assert.equal(proof.typecheck.exitCode, 0)
assert.equal(proof.typecheck.command, 'node_modules/.bin/tsc --noEmit -p apps/desktop/tsconfig.json')
assert.equal(proof.packaging, 'not-requested-not-run')
assert.equal(proof.installation, 'not-requested-not-run')
console.log(JSON.stringify({ passed: true, receipt, sha256: sha(proofBytes), sourceDigest: proof.sourceDigest,
  tests: proof.restored.passed, mutations: proof.mutations.length, callers: proof.callers.length,
  boundary: 'Existing actual production qualification consumed with current exact input bytes. No test rerun, packaging or installation.' }))
