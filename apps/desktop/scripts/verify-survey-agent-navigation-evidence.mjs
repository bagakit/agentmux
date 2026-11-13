import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// A read-only gate over accepted evidence. It never launches a test or an Agent.
assert.equal(process.argv.length, 3, 'Pass the qualified-final.json path')
const root = resolve(import.meta.dirname, '../../..'), qualifiedPath = resolve(process.argv[2])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function read(path, expected) {
  const bytes = await readFile(path)
  assert.ok(bytes.length > 0, 'Nonempty evidence: ' + path)
  assert.match(expected, /^[a-f0-9]{64}$/, 'A frozen SHA-256 is required: ' + path)
  assert.equal(sha(bytes), expected, 'Evidence changed: ' + path)
  return bytes
}
async function json(path, expected) { return JSON.parse(await read(path, expected)) }
async function sources(values) {
  assert.ok(values && Object.keys(values).length > 0, 'Original source hashes are required')
  await Promise.all(Object.entries(values).map(([file, hash]) => read(join(root, file), hash)))
}
const integrity = JSON.parse(await readFile(qualifiedPath + '.integrity.json', 'utf8'))
assert.equal(integrity.schema, 'agentmux.survey-agent-navigation.integrity.v1')
const qualified = await json(qualifiedPath, integrity.qualifiedSha256)
assert.equal(qualified.schema, 'agentmux.survey-agent-navigation.qualified.v1')
assert.equal(qualified.passed, true)
assert.equal(qualified.physicalComposition, 'unverified'); assert.equal(qualified.nativeHitTest, 'unverified')
await sources(qualified.sourceHashes)

const regression = await json(qualified.regression.path, qualified.regression.sha256)
assert.deepEqual(regression.sources, qualified.sourceHashes)
assert.deepEqual(regression.results, qualified.regression.results)
const labels = ['baseline', 'context', 'global', 'late', 'selected']
assert.deepEqual(regression.results.map(row => row.label), labels)
const reportNames = labels.flatMap(label => [label + '.json', ...(label === 'baseline' ? [] : [label + '-hits.jsonl'])])
assert.deepEqual(Object.keys(integrity.reports).sort(), reportNames.sort())
for (const result of regression.results) {
  const label = result.label, directory = dirname(qualified.regression.path)
  const report = await json(join(directory, label + '.json'), integrity.reports[label + '.json'])
  assert.equal(report.testResults.length, 2)
  assert.ok(report.testResults.every(suite => !suite.message && suite.assertionResults.length > 0), 'Module failure is not a semantic oracle')
  const executed = report.testResults.flatMap(suite => suite.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  assert.equal(executed.length, 7); assert.equal(result.executed, 7)
  assert.equal(report.numPassedTests, result.passed); assert.equal(report.numFailedTests, result.failed)
  if (label === 'baseline') { assert.equal(result.code, 0); assert.equal(result.passed, 7); assert.equal(result.failed, 0) }
  else {
    assert.notEqual(result.code, 0)
    const expected = label === 'late' ? 'later save navigation' : label === 'selected' ? 'later none navigation' : 'mounted Survey Browser'
    assert.ok(executed.some(test => test.status === 'failed' && test.fullName.includes(expected)), 'The actual navigation consumer must kill ' + label)
    const hits = (await read(join(directory, label + '-hits.jsonl'), integrity.reports[label + '-hits.jsonl'])).toString().trim().split('\n').map(line => JSON.parse(line))
    assert.ok(hits.length > 0)
    for (const hit of hits) {
      assert.equal(hit.mutant, label)
      const file = Object.keys(qualified.sourceHashes).find(file => hit.id.endsWith('/' + file))
      assert.ok(file); assert.equal(hit.original, qualified.sourceHashes[file])
      assert.equal(file, label === 'context' ? 'apps/desktop/src/renderer/src/components/BrowserPane.tsx' : 'apps/desktop/src/renderer/src/store.ts')
      assert.match(hit.consumed, /^[a-f0-9]{64}$/); assert.notEqual(hit.consumed, hit.original)
    }
  }
}

const native = await json(qualified.native.path, qualified.native.sha256)
assert.equal(native.schema, 'agentmux.survey-agent-navigation-native.v1'); assert.equal(native.passed, true)
await sources(native.sources)
assert.equal(native.phases.length, 2)
for (const phase of native.phases) {
  assert.ok(phase.result.passed && phase.process.exitConfirmed && !phase.process.timedOut)
  assert.equal(phase.process.exitCode, 0); assert.equal(phase.process.originalPid, phase.result.pid)
}
const [seed, restored] = native.phases.map(phase => phase.result)
assert.notEqual(seed.pid, restored.pid)
assert.deepEqual(native.phases.map(phase => ({ pid: phase.result.pid, exit: phase.process.exitCode })), qualified.native.phases)
const original = seed.persisted.find(session => session.agentSessionId === qualified.native.session)
const retained = restored.persisted.find(session => session.agentSessionId === qualified.native.session)
assert.ok(original && retained); assert.deepEqual(original.run, qualified.native.run); assert.deepEqual(retained.run, original.run)
if (qualified.native.nativeHandle) { assert.deepEqual(original.nativeHandle, qualified.native.nativeHandle); assert.deepEqual(retained.nativeHandle, original.nativeHandle) }
assert.deepEqual(seed.firstInput.key, qualified.native.firstInputKey); assert.equal(seed.firstInput.status, 'terminal-confirmed')
assert.equal(seed.firstInput.key.agentSessionId, original.agentSessionId); assert.deepEqual(seed.firstInput.key.expectedRun, original.run)
assert.equal(seed.firstInput.key.submissionId, restored.original.record.browserAgent.messageOperationId)
for (const operation of ['launch', 'submit']) assert.equal(seed.calls.filter(call => call.operation === operation).length, 1)
assert.equal(restored.calls.filter(call => ['launch', 'submit', 'browser-create', 'browser-handoff'].includes(call.operation)).length, 0)
assert.equal(seed.final.mainSurface, 'survey'); assert.equal(restored.final.mainSurface, 'survey')
assert.deepEqual(seed.final.survey, restored.final.survey); assert.deepEqual(seed.final.work, restored.final.work)
assert.deepEqual(seed.final.collected, restored.final.collected)
const record = restored.original.record, reference = restored.original.browser
for (const state of [seed.final, restored.final]) {
  const tab = state.tabs[reference.tabId]
  assert.equal(tab.regions[record.regionId].sessionId, original.agentSessionId)
  assert.equal(tab.regions[reference.regionId].browserId, record.browserAgent.browserId)
}
assert.deepEqual(native.cleanup, { errors: [], remaining: [] }); assert.deepEqual(qualified.native.cleanup, native.cleanup)
assert.equal(qualified.boundary, native.boundary)
assert.equal(qualified.review.status, 'approved')
await read(qualified.review.path, qualified.review.sha256)
assert.deepEqual(Object.keys(qualified.review.images).sort(), ['restore.png', 'seed.png'])
for (const [name, hash] of Object.entries(qualified.review.images)) await read(join(dirname(qualified.native.path), name), hash)
console.log(JSON.stringify({ passed: true, qualified: qualifiedPath, regressions: 7, semanticMutants: 4,
  session: original.agentSessionId, run: original.run, firstInput: seed.firstInput.status,
  physicalComposition: 'unverified', nativeHitTest: 'unverified', boundary: qualified.boundary }, null, 2))
