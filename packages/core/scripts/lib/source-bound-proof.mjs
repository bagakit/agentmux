import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** Reuse actual loaded-source qualification only when every declared input is identical. */
export async function verifySourceBoundProof(receiptPath, { inputs, minPassed, mutations }) {
  const proof = JSON.parse(await readFile(receiptPath, 'utf8'))
  assert.equal(proof.passed, true); assert.equal(proof.sourceStable, true); assert.equal(proof.userRuntimeTouched, false)
  assert.deepEqual(proof.inputs ?? proof.sourceSHA256, inputs, 'Qualification sources, tests or gate changed')
  const candidate = proof.results.find(result => result.name === 'candidate')
  assert.equal(candidate?.code, 0); assert.equal(candidate.failed, 0)
  assert.ok((candidate.total ?? candidate.passed) >= minPassed, 'Candidate must execute nonempty business tests')
  if (candidate.worker !== undefined) assert.match(candidate.worker, /^[a-f0-9]{64}$/u)
  const validateLoaded = rows => {
    assert.ok(rows.length >= 3)
    for (const row of rows) {
      assert.equal(typeof row.source, 'string'); assert.ok(row.source.includes('packages/core/'))
      const key = row.source.slice(row.source.indexOf('packages/core/'))
      assert.ok(Object.hasOwn(inputs, key)); assert.match(row.originalSHA256, /^[a-f0-9]{64}$/u)
      assert.match(row.loadedSHA256, /^[a-f0-9]{64}$/u); assert.equal(row.originalSHA256, inputs[key])
    }
  }
  if (candidate.loaded) {
    validateLoaded(candidate.loaded)
    for (const row of candidate.loaded) assert.equal(row.loadedSHA256, row.originalSHA256)
  } else assert.match(candidate.worker, /^[a-f0-9]{64}$/u)
  for (const name of mutations) {
    const mutant = proof.results.find(result => result.name === name)
    assert.ok(mutant, 'Missing loaded mutation: ' + name); assert.notEqual(mutant.code, 0); assert.ok(mutant.failed > 0)
    if (mutant.loaded) {
      validateLoaded(mutant.loaded)
      assert.equal(mutant.loaded.filter(row => row.loadedSHA256 !== row.originalSHA256).length, 1)
      assert.ok(mutant.assertionFailures.some(test => test.messages.some(message => message.includes('AssertionError'))))
    } else {
      assert.equal(mutant.semanticRed, true); assert.ok(mutant.failedTests.length > 0)
      assert.ok(mutant.assertionHead.some(message => message.includes('AssertionError') ||
        name === 'drop-native-progress' && message === 'Error: Matcher did not succeed in time.'))
      assert.match(mutant.worker, /^[a-f0-9]{64}$/u); assert.notEqual(mutant.worker, candidate.worker)
    }
  }
  return { passed: true, receiptPath, sources: Object.keys(inputs).length, mutations: mutations.length }
}
