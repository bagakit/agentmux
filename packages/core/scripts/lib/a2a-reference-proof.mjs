import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const referenceProofSha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const indexPath = root => join(root, '.tmp/a2a-reference-delivery/current.json')
const edits = ['default-managed-inbox-producer', 'notice-does-not-become-user-request', 'frozen-notice-run-boundary',
  'retained-notice-uses-current-formatter', 'retained-notice-sender-is-unchecked', 'retained-notice-mid-order-is-unchecked',
  'retained-notice-count-is-unchecked', 'retained-notice-context-is-unchecked', 'submitted-reference-leaves-pending-index',
  'new-reference-bridge-is-omitted', 'reference-guide-adapter-is-disconnected']
const nativeEdits = ['native-queue-becomes-steer', 'native-idle-target-is-omitted', 'completion-fence-is-omitted',
  'final-input-fence-is-omitted', 'notification-identity-is-omitted', 'edited-notification-is-adopted',
  'native-queue-receipt-is-unchecked', 'notification-identity-is-not-restored',
  'independent-idle-notification-is-blocked', 'independent-idle-completion-is-consumed',
  'controlled-notice-reservation-spills-to-other-key', 'uncontrolled-notice-reservation-spills-to-other-key']
function local(root, path) {
  const target = resolve(root, path), name = relative(root, target)
  assert.ok(!isAbsolute(name) && name.startsWith('.tmp/') && !name.split('/').includes('..'), 'Proof artifacts stay in their owning evidence area')
  return target
}
async function inputs(root, expected) {
  assert.ok(expected && Object.keys(expected).length > 0, 'Nonempty original proof inputs')
  for (const [path, digest] of Object.entries(expected)) assert.equal(referenceProofSha(await readFile(join(root, path))), digest, 'Current candidate input: ' + path)
}
async function testRun(root, directory, run, red, artifacts, sourceOnly = false) {
  assert.ok(run && run.tests > 0)
  const reportPath = local(root, join(directory, run.report)), report = await json(reportPath)
  artifacts.add(reportPath); artifacts.add(local(root, join(directory, run.log)))
  const cases = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(report.testResults.length > 0 && report.testResults.every(file => file.assertionResults.length > 0))
  assert.equal(report.numTotalTests, run.tests); assert.equal(cases.length, run.tests)
  assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0)
  if (red) {
    assert.ok(run.exit > 0 && report.numFailedTests > 0 && run.assertionFailures > 0)
    assert.ok(cases.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError') || /__VITEST_(?:REJECTS|RESOLVES)__/u.test(message))), 'Implementation mutation must fail an actual behavior assertion')
  } else {
    assert.equal(run.exit, 0); assert.equal(report.success, true); assert.equal(report.numFailedTests, 0)
    assert.ok(cases.every(test => test.status === 'passed'))
  }
  if (sourceOnly) {
    const loadedPath = local(root, join(directory, run.loaded)); artifacts.add(loadedPath)
    const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(loaded.length > 0)
    for (const item of loaded) {
      assert.ok(!isAbsolute(item.file) && !item.file.split('/').includes('..'))
      assert.equal(referenceProofSha(await readFile(join(root, 'packages/core/src', item.file))), item.originalSHA256, 'Actually loaded native source: ' + item.file)
      assert.equal(item.sha256 === item.originalSHA256, !Boolean(item.mutation))
    }
    assert.deepEqual(loaded.filter(item => item.mutation), run.transformed)
    assert.equal(loaded.some(item => item.mutation), red)
  }
  return cases.map(test => test.fullName).sort()
}
async function deliveryFacts({ root, receipt }) {
  const aggregate = await json(local(root, receipt)); assert.equal(aggregate.schema, 'agentmux.a2a-reference-delivery-gate.v1'); assert.equal(aggregate.passed, true)
  const compiledPath = local(root, aggregate.compiled), nativePath = local(root, aggregate.nativeSource)
  const compiled = await json(compiledPath), native = await json(nativePath), artifacts = new Set([local(root, receipt), compiledPath, nativePath])
  assert.equal(compiled.passed, true); assert.equal(compiled.sharedTreeMutations, 0); assert.equal(compiled.cleanup.privateCopyRemoved, true)
  assert.equal(compiled.frozenTests.mutableWorkingTreeUsedByTests, false)
  await inputs(root, compiled.sourceBefore)
  let preparation
  if (compiled.preparation) {
    const path = local(root, compiled.preparation.path), bytes = await readFile(path); artifacts.add(path)
    assert.equal(referenceProofSha(bytes), compiled.preparation.sha256)
    preparation = JSON.parse(bytes)
    const { verifyA2aPreparedArtifact } = await import('../../../../apps/desktop/scripts/lib/a2a-prepared-artifact.mjs')
    await verifyA2aPreparedArtifact(preparation, { root, artifact: 'origin' })
    assert.deepEqual(Object.fromEntries(Object.entries(compiled.compiledInputs).map(([path, digest]) => ['dist/' + path, digest])), preparation.coreGraph, 'The full tested executable graph is the selected prepared Core')
    for (const [path, digest] of Object.entries(preparation.sourceSnapshot.files)) assert.equal(compiled.sourceBefore[path], digest, 'Prepared source and actual tested source: ' + path)
  } else {
    const actualJs = (await readdir(join(root, 'packages/core/dist'), { recursive: true })).filter(path => path.endsWith('.js')).sort()
    assert.deepEqual(Object.keys(compiled.compiledInputs).sort(), actualJs, 'The entire actual Core executable graph is bound')
    for (const file of actualJs) assert.equal(referenceProofSha(await readFile(join(root, 'packages/core/dist', file))), compiled.compiledInputs[file], 'Actual compiled Core: ' + file)
  }
  const directory = dirname(compiledPath), baseline = await testRun(root, directory, compiled.baseline, false, artifacts)
  assert.equal(baseline.length, 26); assert.ok(baseline.some(name => name.includes('across concurrent Core processes and reopening')))
  assert.ok(baseline.some(name => name.includes('budgets the complete bridge and escaped identities')))
  assert.ok(baseline.some(name => name.includes('imports retained container notification history')))
  assert.ok(baseline.some(name => name.includes('invalid retained preceding-context packet')))
  assert.ok(baseline.some(name => name.includes('coalesces at native idle and reads without input or batch ACK')))
  assert.ok(baseline.some(name => name.includes('trusted user reference notifications through flags and JSON')))
  assert.deepEqual(compiled.cases.map(item => item.label), edits)
  for (const item of compiled.cases) assert.deepEqual(await testRun(root, directory, item.red, true, artifacts), await testRun(root, directory, item.restored, false, artifacts))
  assert.equal(native.passed, true); assert.equal(native.sourceOnly, true); assert.equal(native.sharedTreeMutations, 0)
  assert.deepEqual(native.sourceBefore, native.sourceAfter); await inputs(root, native.sourceBefore)
  assert.deepEqual(native.cases.map(item => item.mutation), nativeEdits)
  const nativeDirectory = dirname(nativePath), nativeBaseline = await testRun(root, nativeDirectory, native.baseline, false, artifacts, true)
  assert.equal((await testRun(root, nativeDirectory, native.regression, false, artifacts, true)).length, 30)
  for (const item of native.cases) {
    assert.deepEqual(await testRun(root, nativeDirectory, item.red, true, artifacts, true), nativeBaseline)
    assert.deepEqual(await testRun(root, nativeDirectory, item.restored, false, artifacts, true), nativeBaseline)
    assert.ok(item.red.transformed.every(record => record.mutation === item.mutation))
  }
  const factPath = local(root, join(directory, 'baseline-green-native-facts.jsonl')); artifacts.add(factPath)
  const facts = (await readFile(factPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const reopened = facts.filter(item => item.scenario === 'idle-coalescing-and-reopen'); assert.equal(reopened.length, 1)
  const original = reopened[0]
  assert.ok(original.before.runId && original.before.pid > 0); assert.equal(original.after.runId, original.before.runId); assert.equal(original.after.pid, original.before.pid)
  assert.equal(original.after.acceptedInputBytes, original.before.acceptedInputBytes); assert.equal(original.requests, 1)
  assert.deepEqual(original.restoredNotification, original.original); assert.equal(original.bodyAfterReopen, original.originalBody); assert.equal(original.originalIds.length, 2)
  assert.equal(original.original.key.expectedRun.runId, original.before.runId); assert.ok(!original.originalIds.includes(original.original.key.submissionId))
  const isolated = facts.filter(item => item.scenario === 'same-idle-unknown-and-new-mid'); assert.equal(isolated.length, 1)
  assert.deepEqual(isolated[0].restoredKey, isolated[0].originalKey); assert.notDeepEqual(isolated[0].independentKey, isolated[0].originalKey)
  assert.equal(isolated[0].requests.length, 2); assert.deepEqual(isolated[0].requests[0].nativeStatus, isolated[0].requests[1].nativeStatus)
  assert.ok(isolated[0].requests[1].wire.includes(isolated[0].newMid) && !isolated[0].requests[1].wire.includes(isolated[0].oldMid))
  return { aggregate, compiled, preparation, artifacts, reopened: original, facts: isolated[0] }
}

/** Seal original execution artifacts; verification never reruns a Provider or model. */
export async function sealReferenceDeliveryProof({ root, receipt }) {
  const facts = await deliveryFacts({ root, receipt }), path = join(dirname(receipt), 'verified-artifacts.json')
  const artifacts = Object.fromEntries(await Promise.all([...facts.artifacts].map(async file => [relative(root, file), referenceProofSha(await readFile(file))])))
  await writeFile(path, JSON.stringify({ schema: 'agentmux.a2a-reference-delivery-artifacts.v1', receipt: relative(root, receipt), artifacts }, null, 2) + '\n')
  await mkdir(dirname(indexPath(root)), { recursive: true })
  await writeFile(indexPath(root), JSON.stringify({ path: relative(root, path), sha256: referenceProofSha(await readFile(path)) }) + '\n')
  return await verifyReferenceDeliveryProof({ root })
}
export async function verifyReferenceDeliveryProof({ root, index }) {
  index ??= await json(indexPath(root))
  const bytes = await readFile(local(root, index.path)); assert.equal(referenceProofSha(bytes), index.sha256)
  const sealed = JSON.parse(bytes); assert.equal(sealed.schema, 'agentmux.a2a-reference-delivery-artifacts.v1'); assert.ok(Object.keys(sealed.artifacts).length > 30)
  for (const [path, digest] of Object.entries(sealed.artifacts)) assert.equal(referenceProofSha(await readFile(local(root, path))), digest, 'Bound original execution artifact: ' + path)
  const facts = await deliveryFacts({ root, receipt: sealed.receipt })
  assert.deepEqual([...facts.artifacts].map(path => relative(root, path)).sort(), Object.keys(sealed.artifacts).sort())
  return { passed: true, receipt: sealed.receipt, artifactIndex: index.path, sha256: index.sha256,
    sources: facts.compiled.sourceBefore, compiled: facts.compiled.compiledInputs, preparation: facts.preparation,
    cases: facts.compiled.baseline.tests, compiledMutants: edits.length, nativeSourceMutants: nativeEdits.length, reopen: facts.reopened, sameIdleUnknown: facts.facts }
}

function assertSameReferencePreparation(candidate, original) {
  const selected = original?.kind ?? 'source-build', received = candidate?.kind ?? 'source-build'
  assert.ok([selected, received].every(mode => ['source-build', 'prepared-artifact'].includes(mode)), 'Every consumer has an explicit supported origin mode')
  assert.equal(received, selected, 'Delivery, Desktop and model must use the same origin mode')
  if (selected === 'prepared-artifact') {
    assert.deepEqual(candidate.identity, original.identity, 'One fixed original source identity')
    assert.deepEqual(candidate.input, original.input, 'One explicit prepared origin selection')
    assert.equal(candidate.artifact.inventory.sha256, original.artifact.inventory.sha256, 'One complete executable and dependency inventory')
    assert.deepEqual(candidate.coreGraph, original.coreGraph)
  }
  return selected
}

/** Reject a known delivery/product mismatch before paying for a real model sample. */
export function assertReferenceProductCandidate({ delivery, product }) {
  const prepared = assertSameReferencePreparation(delivery.preparation, product.preparation) === 'prepared-artifact'
  const expectedJs = Object.keys(delivery.compiled).map(file => 'packages/core/dist/' + file).sort()
  assert.ok(expectedJs.length > 100, 'A complete Core executable graph is required')
  const productCompiled = prepared ? Object.fromEntries(Object.entries(product.preparation.coreGraph).map(([path, digest]) => ['packages/core/' + path, digest])) : product.compiled
  assert.deepEqual(Object.keys(productCompiled).filter(file => file.startsWith('packages/core/dist/') && file.endsWith('.js')).sort(), expectedJs, 'One exact Desktop Core executable graph')
  for (const [file, digest] of Object.entries(delivery.compiled)) assert.equal(productCompiled['packages/core/dist/' + file], digest, 'Desktop actual Core executable candidate: ' + file)
  const productSources = Object.keys(delivery.sources).filter(path => path in product.sources)
  assert.ok(prepared ? productSources.length > 0 : productSources.length >= 15)
  for (const path of productSources) assert.equal(product.sources[path], delivery.sources[path], 'Desktop original source candidate: ' + path)
  return { prepared, expectedJs, productSources }
}

/** Joined evidence binds executable bytes and original source facts, never Git ancestry alone. */
export function assertJoinedReferenceCandidate({ delivery, product, model, modelPreparation, fixedCoreSources }) {
  const { prepared, expectedJs, productSources } = assertReferenceProductCandidate({ delivery, product })
  assertSameReferencePreparation(modelPreparation, product.preparation)
  assert.equal(model.passed, true); assert.equal(model.frozenCandidate.compiledSnapshot, true)
  assert.deepEqual(model.compiledBefore, model.compiledAfter)
  assert.deepEqual(Object.keys(model.compiledBefore).sort(), expectedJs, 'One exact model executable graph')
  if (prepared) {
    assert.ok(Object.keys(fixedCoreSources).length >= 30)
    for (const inputs of [delivery.sources, model.sourceBefore, product.sources]) {
      for (const [path, digest] of Object.entries(inputs)) if (/^packages\/core\/(?:src\/|guides\/|bin\/)/u.test(path)) {
        assert.ok(Object.hasOwn(fixedCoreSources, path), 'The immutable source join must cover every relevant production input: ' + path)
        assert.equal(digest, fixedCoreSources[path], 'Original immutable product source: ' + path)
      }
    }
  }
  const sharedSources = Object.keys(delivery.sources).filter(path => path in model.sourceBefore)
  assert.ok(sharedSources.length >= 20)
  for (const path of sharedSources) assert.equal(model.sourceBefore[path], delivery.sources[path], 'Model original source candidate: ' + path)
  for (const [file, digest] of Object.entries(delivery.compiled)) assert.equal(model.compiledBefore['packages/core/dist/' + file], digest, 'Model actual executable candidate: ' + file)
  const modelProductSources = Object.keys(model.sourceBefore).filter(path => path in product.sources)
  assert.ok(prepared ? modelProductSources.length > 0 : modelProductSources.length >= 30)
  for (const path of modelProductSources) assert.equal(product.sources[path], model.sourceBefore[path], 'One original model and Desktop source: ' + path)
  return { sharedModelProductSources: modelProductSources, sharedModelSources: sharedSources, sharedProductSources: productSources,
    ...(prepared ? { immutableCoreSources: Object.keys(fixedCoreSources), immutableCoreSourceSHA256: referenceProofSha(JSON.stringify(fixedCoreSources)) } : {}), executableFiles: Object.keys(delivery.compiled).length }
}
