import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
const parse = async file => JSON.parse(await readFile(file, 'utf8'))
const digest = async file => hash(await readFile(file))
const absolute = (root, file) => path.resolve(root, file)
const assertions = report => report.testResults.flatMap(suite => suite.assertionResults)
const executed = report => assertions(report).filter(one => ['passed', 'failed'].includes(one.status))

async function verifySourcePins(root, pins, anchor) {
  const entries = Object.entries(pins ?? {})
  assert.ok(entries.length > 0, 'An owner proof has no source inputs.')
  const originalAnchor = entries.find(([file]) => file === anchor || file.endsWith('/' + anchor))?.[0]
  assert.ok(originalAnchor, 'The exact owning gate is absent from its source inputs.')
  const originalRoot = path.isAbsolute(originalAnchor) ? originalAnchor.slice(0, -anchor.length) : root
  for (const [file, sha256] of entries) {
    assert.match(sha256, /^[a-f0-9]{64}$/u)
    const relative = path.isAbsolute(file) ? path.relative(originalRoot, file) : file
    // Original gates also pin the exact externally resolved dependency files.
    // Project source follows the joined checkout; dependency bytes keep their original locator.
    const external = relative.startsWith('..') || path.isAbsolute(relative)
    assert.ok(!external || file.includes('/node_modules/'), 'An owner pin escaped its project and dependency roots.')
    assert.equal(await digest(external ? absolute(root, file) : absolute(root, relative)), sha256, 'Owner proof belongs to another source candidate: ' + relative)
  }
  return entries.length
}

async function verifyReport(file, green, minimum = 1, expected = {}, totalMode = 'collected') {
  const report = await parse(file), all = assertions(report), ran = executed(report)
  assert.ok(report.testResults.length > 0 && ran.length > 0, 'The original owner report has no executed business cases.')
  assert.ok(report.testResults.every(suite => suite.assertionResults.length > 0 && !suite.message), 'An owner collection/setup error cannot qualify.')
  const counts = { total: totalMode === 'executed' ? ran.length : all.length,
    passed: ran.filter(one => one.status === 'passed').length, failed: ran.filter(one => one.status === 'failed').length }
  // Vitest includes deliberately skipped cases in its declared total. The
  // Desktop gate instead writes an aggregate containing only executed cases.
  for (const [key, field] of Object.entries({ total: 'numTotalTests', passed: 'numPassedTests', failed: 'numFailedTests' })) {
    assert.equal(report[field], counts[key], 'Original owner report count mismatch: ' + key)
    if (key in expected) assert.equal(expected[key], counts[key], 'Original owner producer count mismatch: ' + key)
  }
  assert.ok(ran.length >= minimum, 'The original owner report omitted required business cases.')
  assert.equal(report.success, green, 'The original owner report contradicts its process outcome.')
  if (green) {
    assert.ok(ran.every(one => one.status === 'passed'), 'The owner baseline is not green.')
  } else {
    const red = ran.filter(one => one.status === 'failed')
    assert.ok(red.some(one => one.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .+ to |promise resolved .+ instead of rejecting/su.test(message))), 'A loaded mutation lacks a business assertion failure.')
  }
  return ran
}

/** Read the existing producer's source pins, raw reports and loaded module hashes. */
export async function readSessionOwnerProof(root, task, file) {
  const receiptPath = absolute(root, file), receipt = await parse(receiptPath), directory = path.dirname(receiptPath)
  const definitions = {
    T001: { schema: 'agentmux.session-refresh-proof.v1', gate: 'packages/core/scripts/verify-session-refresh.mjs', minimum: 11, mutants: 8 },
    T003: { schema: 'agentmux.post-start-availability-proof.v1', gate: 'packages/core/scripts/verify-agent-post-start-availability.mjs', minimum: 13, mutants: 6 },
    T006: { schema: 'agentmux.durable-local-creation-proof.v1', gate: 'packages/core/scripts/verify-durable-local-creation.mjs', minimum: 32, mutants: 7 },
    T007: { schema: 'agentmux.durable-direct-resume-proof.v1', gate: 'packages/core/scripts/verify-durable-direct-resume.mjs', minimum: 34, mutants: 9 }
  }
  const definition = definitions[task]
  assert.ok(definition, 'Unknown original owner task.')
  assert.equal(receipt.schema, definition.schema)
  assert.equal(task === 'T001' ? receipt.qualified : receipt.passed, true)
  if (task !== 'T003') assert.equal(receipt.sourceStable, true)
  const sourceInputs = await verifySourcePins(root, receipt.inputs ?? receipt.before, definition.gate)
  const results = task === 'T001' ? [receipt.baseline, ...receipt.mutants] : receipt.results
  const green = results.filter(one => one.code === 0), red = results.filter(one => one.code !== 0)
  assert.ok(green.length > 0 && red.length >= definition.mutants, 'An original owner proof omitted its baseline or loaded counterexamples.')
  assert.equal(new Set(results.map(one => one.name)).size, results.length, 'Duplicate owner variants cannot replace omitted counterexamples.')
  const baselineSha = task === 'T001' ? receipt.baseline.compiled.sha256 : green[0].bundleSha256
  const baselineCases = new Set()
  for (const result of results) {
    assert.equal(result.signal, null)
    const report = result.report ? absolute(root, result.report) : path.join(directory, result.name + '.json')
    for (const field of ['total', 'passed', 'failed']) assert.ok(Number.isInteger(result[field]) && result[field] >= 0, 'An owner producer omitted its case counts.')
    const cases = await verifyReport(report, result.code === 0, result.code === 0 ? definition.minimum : 1,
      { total: result.total, passed: result.passed, failed: result.failed })
    if (result.code === 0) for (const one of cases) baselineCases.add(one.fullName)
    const module = path.join(directory, ...(task === 'T001' ? [] : ['package', 'dist']), result.name + '.mjs')
    const sha256 = task === 'T001' ? result.compiled.sha256 : result.bundleSha256
    assert.equal(await digest(module), sha256, 'The original loaded owner module changed.')
    if (result.code !== 0) {
      assert.equal(result.code, 1); assert.equal(result.semanticRed, true)
      assert.notEqual(sha256, baselineSha)
      if (task === 'T001') assert.equal(result.compiled.transformed, true)
    }
  }
  if (task === 'T003') assert.ok(receipt.callers.length > 0 && receipt.callers.every(one => one.calls.length > 0))
  if (task === 'T007') assert.ok(receipt.consumers.length > 0)
  return { task, receipt: receiptPath, sha256: await digest(receiptPath), sourceInputs, baselineCases: green[0].passed,
    executedBaselineCases: [...baselineCases], loadedCounterexamples: red.length }
}

async function readExecutableProof(root) {
  const file = absolute(root, '.tmp/session-capability-recovery/executable-context/receipt.json')
  const receipt = await parse(file), directory = path.dirname(file)
  assert.equal(receipt.schema, 'agentmux.executable-launch-context-proof.v1'); assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  const sourceInputs = await verifySourcePins(root, receipt.sourceAfter, 'packages/core/scripts/verify-executable-launch-context.mjs')
  assert.ok(receipt.baseline >= 26 && receipt.mutations.length >= 19)
  await verifyReport(path.join(directory, 'current.json'), true, 26, { total: receipt.baseline, passed: receipt.baseline, failed: 0 })
  assert.equal(new Set(receipt.mutations.map(one => one.name)).size, receipt.mutations.length)
  for (const mutation of receipt.mutations) {
    const cases = await verifyReport(path.join(directory, mutation.name + '.json'), false, 1,
      { total: receipt.baseline, failed: mutation.failures.length })
    assert.deepEqual(cases.filter(one => one.status === 'failed').map(one => one.fullName).sort(), mutation.failures.map(one => one.fullName).sort())
    assert.equal(mutation.loaded.sourceSha, receipt.sourceBefore[mutation.loaded.path]); assert.notEqual(mutation.loaded.sourceSha, mutation.loaded.loadedSha)
    const loaded = (await readFile(path.join(directory, mutation.name + '.loaded.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(loaded.some(one => one.sourceSha === mutation.loaded.sourceSha && one.loadedSha === mutation.loaded.loadedSha))
  }
  return { task: 'T004', receipt: file, sha256: await digest(file), sourceInputs, baselineCases: receipt.baseline, loadedCounterexamples: receipt.mutations.length }
}

async function readRecoveryPresentation(root) {
  const directory = absolute(root, '.tmp/recovery-robustness-actions/recovery-actions')
  const file = path.join(directory, 'qualification.json'), receipt = await parse(file)
  assert.equal(receipt.schema, 'agentmux.session-recovery-actions-source.v1'); assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.inputsBefore, receipt.inputsAfter)
  const sourceInputs = await verifySourcePins(root, receipt.inputsAfter, 'apps/desktop/scripts/verify-session-recovery-actions.mjs')
  assert.ok(receipt.current.code === 0 && receipt.current.passed >= 69 && receipt.current.passed === receipt.current.tests)
  assert.ok(receipt.mutations.length >= 16 && Object.values(receipt.callers).every(one => one.length > 0))
  const presentationCounts = result => ({ total: result.tests, passed: result.passed, failed: result.tests - result.passed })
  await verifyReport(path.join(directory, 'baseline-source-green.json'), true, 69, presentationCounts(receipt.baseline), 'executed')
  await verifyReport(path.join(directory, 'current-source-green.json'), true, 69, presentationCounts(receipt.current), 'executed')
  for (const mutation of receipt.mutations) {
    assert.equal(mutation.code, 1); assert.ok(mutation.assertionRed.length > 0)
    assert.equal(mutation.restored.code, 0); assert.equal(mutation.restored.tests, mutation.restored.passed)
    assert.equal(mutation.loaded.sourceSha256, receipt.inputsAfter[mutation.loaded.file])
    assert.notEqual(mutation.loaded.loadedVariantSha256, mutation.loaded.sourceSha256)
    await verifyReport(path.join(directory, mutation.id + '-red.json'), false, 1, presentationCounts(mutation), 'executed')
    await verifyReport(path.join(directory, mutation.id + '-restored-green.json'), true, 69, presentationCounts(mutation.restored), 'executed')
  }
  const sceneFile = path.join(directory, 'presentation.json'), scene = await parse(sceneFile), review = await parse(path.join(directory, 'visual-review.json'))
  assert.equal(scene.passed, true); assert.equal(scene.userRuntimeTouched, false)
  assert.equal(review.sceneSha256, await digest(sceneFile)); assert.equal(review.actualImagesOpened, true)
  assert.equal(review.verdict, 'approved'); assert.deepEqual(review.unresolvedMustFix, [])
  assert.ok(review.reviewedBy && scene.images.length >= 2)
  await verifySourcePins(root, scene.sourcePins, 'apps/desktop/src/renderer/src/components/SessionPane.tsx')
  for (const image of scene.images) {
    assert.equal(await digest(image.path), image.sha256)
    assert.ok(review.images.some(one => one.path === image.path && one.sha256 === image.sha256 && one.opened === true))
  }
  return { task: 'T002', receipt: file, sha256: await digest(file), sourceInputs, baselineCases: receipt.current.passed,
    loadedCounterexamples: receipt.mutations.length, sceneSha256: await digest(sceneFile), reviewSha256: await digest(path.join(directory, 'visual-review.json')) }
}

/** No authored success manifest: every dependency comes from its original gate. */
export async function readSessionCapabilityEvidence(root) {
  const pointer = async file => (await parse(absolute(root, file))).receipt
  const receipts = [
    await readSessionOwnerProof(root, 'T001', await pointer('.tmp/session-capability-recovery/refresh-latest.json')),
    await readRecoveryPresentation(root),
    await readSessionOwnerProof(root, 'T003', await pointer('packages/core/.tmp/post-start-availability/latest.json')),
    await readExecutableProof(root),
    await readSessionOwnerProof(root, 'T006', await pointer('packages/core/.tmp/durable-local-creation/latest.json')),
    await readSessionOwnerProof(root, 'T007', await pointer('packages/core/.tmp/durable-direct-resume/latest.json'))
  ]
  return receipts
}
