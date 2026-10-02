import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { verifyIntegration, checkInputs, checkInputs as checkCurrentInputs, readProof, readPinnedProof, proofDirectory } from './verify-object-cli-rpc-integration.mjs'

const integration = await verifyIntegration()
const continuation = await readProof(integration.continuation)
assert.equal(continuation.historicalOwners.length, 3)
const owners = []
for (const scope of continuation.historicalOwners) {
  const owner = await readPinnedProof(scope.owner)
  owners.push(owner)
  // Historical execution keeps its recorded inputs. Only its exact saved caller/mutant
  // Source is read here; the current candidate and compiled inputs were checked above.
  assert.ok(owner.sourceInputs && Object.keys(owner.sourceInputs).length > 0)
  for (const [relative, expected] of Object.entries(owner.sourceInputs)) {
    assert.ok(!path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes('..'))
    assert.match(expected, /^[a-f\d]{64}$/u)
  }
  const expectedSources = { ...owner.sourceInputs }
  if (owner.schema === 'agentmux.public-rpc-owner.private.v1') {
    for (const caller of Object.values(owner.callerChecks)) {
      for (const reference of caller.nonDefinitionNonImportProductionCalls) {
        if (Object.hasOwn(expectedSources, reference.path)) assert.equal(expectedSources[reference.path], reference.sourceSha256)
        expectedSources[reference.path] = reference.sourceSha256
      }
    }
  }
  const readProof = async relative => {
    assert.ok(Object.hasOwn(scope.artifacts, relative), `Historical report has no exact backing: ${relative}`)
    return readPinnedProof(scope.artifacts[relative])
  }
  const checkInputs = async inputs => {
    assert.ok(inputs && Object.keys(inputs).length > 0)
    for (const [relative, expected] of Object.entries(inputs)) {
      assert.equal(expectedSources[relative], expected, 'Source must belong to its original recorded inputs or caller checks')
      assert.ok(Object.hasOwn(scope.sources, relative), `Historical Source has no exact backing: ${relative}`)
      assert.equal(scope.sources[relative].sha256, expected)
      await checkCurrentInputs({ [scope.sources[relative].path]: expected })
    }
  }
  const readSource = async relative => {
    await checkInputs({ [relative]: expectedSources[relative] })
    return readFile(path.resolve(proofDirectory, '../../', scope.sources[relative].path), 'utf8')
  }
  assert.equal(owner.passed, true)
  assert.ok(Object.keys(scope.sources).length > 0, 'Historical Source backing cannot be empty')
  for (const relative of Object.keys(scope.sources)) await checkInputs({ [relative]: expectedSources[relative] })
  if (owner.schema === 'agentmux.public-rpc-owner.private.v1') {
    assert.deepEqual(owner.sourceInputsAfter, owner.sourceInputs)
    assert.equal(owner.build.exitCode, 0)
    const types = await readProof(owner.types.currentPublicConsumer.path)
    assert.equal(types.success, true)
    assert.equal(types.numFailedTests, 0)
    assert.ok(types.numPassedTests > 0)
    const report = await readProof(owner.owning.result)
    assert.equal(report.success, true)
    assert.equal(report.numFailedTests, 0)
    assert.ok(report.numPassedTests > 0)
    for (const scoped of [owner.actualWireCancellation.opening, owner.actualWireCancellation.notification]) {
      assert.ok(scoped, 'Both stream callback cancellation boundaries need their owning proof')
      const mutation = await readProof(scoped.path)
      assert.equal(mutation.passed, true)
      assert.equal(mutation.red.assertionRed, true)
      assert.ok(mutation.red.failed > 0)
      assert.equal(mutation.restored.failed, 0)
      assert.ok(mutation.restored.passed > 0)
      assert.equal((await readProof(mutation.restored.result)).success, true)
    }
    assert.ok(owner.mutations.length > 0)
    for (const mutation of owner.mutations) {
      if (mutation.receipt && typeof mutation.receipt === 'object') {
        const scoped = await readProof(mutation.receipt.path)
        assert.equal(scoped.red.assertionRed, true)
        assert.ok(scoped.red.failed > 0)
        assert.equal(scoped.restored.failed, 0)
        assert.ok(scoped.restored.passed > 0)
        continue
      }
      const red = await readProof(mutation.red)
      const green = await readProof(mutation.restored)
      assert.ok(red.numFailedTests > 0)
      assert.ok(red.testResults.flatMap(result => result.assertionResults).some(result =>
        result.status === 'failed' && result.failureMessages.some(message =>
          /AssertionError|at _Assertion\.__VITEST_(?:REJECTS|RESOLVES)__/u.test(message))))
      assert.equal(green.success, true)
      assert.equal(green.numFailedTests, 0)
      assert.ok(green.numPassedTests > 0)
    }
    const callers = Object.values(owner.callerChecks)
    assert.ok(callers.length > 0)
    for (const caller of callers) {
      assert.ok(caller.nonDefinitionNonImportProductionCalls.length > 0)
      for (const reference of caller.nonDefinitionNonImportProductionCalls) {
        assert.ok(!/(?:^|\/)test(?:s)?\//u.test(reference.path))
        await checkInputs({ [reference.path]: reference.sourceSha256 })
        const source = await readSource(reference.path)
        assert.ok(source.split('\n')[reference.line - 1]?.includes(reference.call))
      }
    }
    continue
  }
  if (owner.schema === 'agentmux.cli-quality.v1') {
    assert.ok(owner.runs.length > 0)
    for (const run of owner.runs) {
      assert.equal(run.passed, true)
      assert.ok(run.command.length > 0 && run.passedTests > 0)
      assert.equal(run.failedTests, 0)
      const report = await readProof(run.report)
      assert.equal(report.success, true)
      assert.ok(report.numPassedTests > 0)
      assert.equal(report.numFailedTests, 0)
    }
    assert.ok(owner.mutations.length > 0)
    for (const mutation of owner.mutations) {
      assert.notEqual(mutation.red.code, 0)
      assert.ok(mutation.red.failed > 0 && mutation.red.assertionFails.length > 0)
      assert.ok(mutation.red.assertionFails.some(failure => failure.messages.some(message => message.includes('AssertionError'))))
      assert.equal(mutation.green.code, 0)
      assert.equal(mutation.green.failed, 0)
      assert.ok(mutation.green.passed > 0)
      assert.equal((await readProof(mutation.green.report)).success, true)
    }
    const callers = Object.values(owner.callers)
    assert.ok(callers.length > 0)
    for (const caller of callers) {
      assert.ok(caller.actualCallers.length > 0)
      for (const reference of caller.actualCallers) {
        assert.notEqual(reference.path, caller.definition)
        assert.ok(!/(?:^|\/)test(?:s)?\//u.test(reference.path))
        assert.ok(Object.hasOwn(owner.sourceInputs, reference.path))
        const source = await readSource(reference.path)
        assert.equal(source.split('\n')[reference.line - 1]?.trim(), reference.text.trim())
      }
    }
    continue
  }
  assert.ok(owner.checks.length > 0, 'Owning checks cannot be empty')
  assert.ok(owner.checks.every(check => check.passed === true && check.command.length > 0))
  assert.ok(owner.mutations.length > 0, 'Owning mutations cannot be empty')
  for (const mutation of owner.mutations) {
    assert.equal(mutation.assertionRed, true, 'Setup failures cannot sign a mutation')
    assert.equal(mutation.restoredGreen, true)
    await checkInputs({ [mutation.source]: mutation.sourceSha256 })
  }
  assert.ok(owner.callers.length > 0, 'Public capabilities need production consumers')
  for (const caller of owner.callers) {
    assert.ok(caller.references.length > 0)
    assert.ok(caller.references.every(reference => reference !== caller.definition && !/(?:^|\/)test(?:s)?\//u.test(reference)))
    for (const reference of caller.references) {
      assert.ok(Object.hasOwn(owner.sourceInputs, reference), 'Caller must belong to reviewed inputs')
      await checkInputs({ [reference]: owner.sourceInputs[reference] })
    }
  }
}
assert.deepEqual(owners.map(owner => owner.schema), ['agentmux.public-rpc-owner.private.v1',
  'agentmux.cli-quality.v1', 'agentmux.object-cli-rpc.root-owning.v1'])
const historicalReview = await readPinnedProof(continuation.historicalReview)
assert.equal(historicalReview.accepted, true)
assert.deepEqual(historicalReview.unresolved, [])
assert.equal(historicalReview.visual.accepted, true)
const historicalSupplement = await readPinnedProof(continuation.historicalSupplement)
assert.equal(historicalSupplement.root.manifest.sha256, continuation.historicalOwners[2].owner.sha256)
assert.equal(historicalSupplement.root.allSourceExact, true)
assert.equal(historicalSupplement.root.sourceCount, Object.keys(owners[2].sourceInputs).length)
const checkHistoricalArtifact = async (relative, expected) => {
  assert.ok(Object.hasOwn(continuation.historicalArtifacts, relative), `Historical artifact has no exact backing: ${relative}`)
  const backing = continuation.historicalArtifacts[relative]
  assert.equal(backing.sha256, expected)
  await checkCurrentInputs({ [backing.path]: expected })
  return readFile(path.resolve(proofDirectory, '../../', backing.path))
}
await checkHistoricalArtifact(historicalReview.artifact, historicalReview.artifactSha256)
assert.ok(historicalReview.visual.artifacts.length > 0)
for (const artifact of historicalReview.visual.artifacts) {
  const png = await checkHistoricalArtifact(artifact.path, artifact.sha256)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
}
const review = await readPinnedProof(continuation.review)
assert.equal(review.accepted, true)
assert.deepEqual(review.unresolved, [])
assert.ok(review.artifact.length > 0)
assert.ok(!path.isAbsolute(review.artifact) && !review.artifact.split(/[\\/]/u).includes('..'))
assert.match(review.artifactSha256, /^[a-f\d]{64}$/u)
assert.equal(createHash('sha256').update(await readFile(path.resolve(proofDirectory, '../../', review.artifact))).digest('hex'), review.artifactSha256)
assert.deepEqual(review.inputs, integration.inputs, 'Final independent review must cover the complete current candidate')
await checkInputs(review.inputs)
assert.equal(review.visual.accepted, true)
assert.ok(review.visual.artifacts.length > 0)
for (const artifact of review.visual.artifacts) {
  assert.ok(typeof artifact.path === 'string' && !path.isAbsolute(artifact.path) && !artifact.path.split(/[\\/]/u).includes('..'))
  assert.match(artifact.sha256, /^[a-f\d]{64}$/u)
  const png = await readFile(path.resolve(proofDirectory, '../../', artifact.path))
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Visual proof must contain an actual PNG')
  assert.equal(createHash('sha256').update(png).digest('hex'), artifact.sha256)
}
const receipt = { schema: 'agentmux.object-cli-rpc.acceptance.v1', passed: true,
  integration: 'integration.continuation.json', inputs: integration.inputs,
  historicalOwners: continuation.historicalOwners.map(scope => scope.owner),
  history: { review: continuation.historicalReview, supplement: continuation.historicalSupplement,
    recordedInputs: historicalReview.inputs },
  review: review.artifact, visual: review.visual, ownerChecks: owners.map(owner => owner.schema === 'agentmux.cli-quality.v1'
    ? owner.runs : owner.schema === 'agentmux.public-rpc-owner.private.v1' ? [owner.owning] : owner.checks) }
await writeFile(path.join(proofDirectory, 'acceptance.continuation.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, proof: 'acceptance.continuation.json' }))
