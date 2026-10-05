import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const scope = process.argv[process.argv.indexOf('--scope') + 1]
assert.ok(scope === 'resources' || scope === 'overview', 'Choose the exact resources or overview acceptance scope')
const root = resolve(import.meta.dirname, '../../..')
const directory = resolve(process.env.AGENTMUX_ATTRIBUTION_ACCEPTANCE ?? resolve(root, ".local/state/performance-attribution-fixture"))
const sha = value => createHash('sha256').update(value).digest('hex')
const store = 'apps/desktop/src/renderer/src/store.ts'
function qualify(file, { allowStoreJoin = false, minimumTests, mutants, verifier } = {}) {
  const bytes = readFileSync(file), receipt = JSON.parse(bytes)
  assert.equal(receipt.passed, true, 'Candidate owner qualification must have passed')
  for (const key of ['sourceSHA256', 'testSHA256']) {
    assert.ok(Object.keys(receipt[key] ?? {}).length > 0, 'Nonempty exact candidate inputs')
    for (const [path, digest] of Object.entries(receipt[key])) {
      if (allowStoreJoin && key === 'sourceSHA256' && path === store) continue
      assert.equal(sha(readFileSync(resolve(root, path))), digest, `Qualification drift: ${path}`)
    }
  }
  assert.equal(sha(readFileSync(resolve(root, 'apps/desktop/scripts/performance-owner-proof.mjs'))), receipt.helperSHA256)
  assert.ok(receipt.callers?.length > 0 && receipt.runs?.length > 1, 'Real callers and actual production mutants required')
  assert.ok(receipt.runs[0].tests >= minimumTests && receipt.runs[0].failed === 0)
  assert.equal(receipt.runs.length - 1, mutants)
  for (const run of receipt.runs.slice(1)) assert.ok(run.tests > 0 && run.failed > 0, 'Mutants must fail executed assertions')
  for (const caller of receipt.callers) {
    if (allowStoreJoin && caller.path === store) continue
    assert.equal(sha(readFileSync(resolve(root, caller.path))), caller.sha256, 'Actual caller drift')
  }
  assert.equal(sha(readFileSync(resolve(root, verifier))), receipt.verifierSHA256)
  return {receipt, sha256:sha(bytes)}
}
const refs = JSON.parse(readFileSync(resolve(directory, 'acceptance.json')))
const join = qualify(refs.join, {minimumTests:23, mutants:1, verifier:'apps/desktop/scripts/verify-performance-attribution-join.mjs'})
const resource = qualify(refs.resources, {allowStoreJoin:true, minimumTests:17, mutants:22, verifier:'apps/desktop/scripts/verify-performance-attribution-resources.mjs'})
// The only changed owner is a shared Store navigation hunk. Reuse its earlier
// mutants only when the actually executed metrics callback is byte-identical.
for (const proof of [resource, join]) assert.equal(proof.receipt.astValidated, true)
const callbacks = proof => [...new Set(proof.receipt.astExecutions.filter(value =>
  value.run === 'normal' && value.operation === 'metrics.renderer' && value.invoked && !value.threw &&
  value.sourceSHA256 === proof.receipt.sourceSHA256[store]).map(value => value.callbackSHA256))]
assert.equal(callbacks(resource).length, 1); assert.deepEqual(callbacks(join), callbacks(resource))
const nativeBytes = readFileSync(refs.nativeCapture), native = JSON.parse(nativeBytes)
assert.equal(native.completed, true); assert.equal(native.captureScope, 'attribution')
assert.equal(native.sourceCurrentReadbackExact, true); assert.deepEqual(native.changedAfterCapture, [])
assert.deepEqual(native.remainingPrivateProcesses, []); assert.equal(native.privateRootRemoved, true)
for (const path of ['apps/desktop/src/preload/index.ts', 'packages/core/src/metrics.ts',
  'apps/desktop/src/renderer/src/components/performance/PerformanceAttribution.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx',
  'apps/desktop/src/renderer/src/styles/performance-toolkit.css',
  'apps/desktop/scripts/fixtures/performance-panel/main.cjs',
  'apps/desktop/scripts/fixtures/performance-panel/capture.mjs',
  'apps/desktop/scripts/fixtures/performance-panel/data.ts',
  'apps/desktop/scripts/fixtures/performance-panel/entry.tsx']) {
  assert.equal(sha(readFileSync(resolve(root, path))), native.inputs[path]?.sha256, `Native capture input drift: ${path}`)
}
const rawRef = native.rawInputs.find(value => value.phase === 'attribution')
const rawBytes = readFileSync(resolve(native.evidence, rawRef.file))
assert.equal(sha(rawBytes), rawRef.sha256)
const raw = JSON.parse(rawBytes), memory = raw.rendererMemoryProof
assert.equal(raw.qualified, true); assert.equal(memory.strictCoreParserPassed, true)
assert.equal(memory.contextIsolation, true); assert.equal(memory.sandbox, true); assert.equal(memory.nodeIntegration, false)
assert.equal(memory.actual.process.pid, memory.osPid); assert.ok(memory.osPid > 0)
assert.equal(memory.actual.process.creationTime, memory.nativeCreationTime); assert.ok(memory.nativeCreationTime > 0)
assert.equal(memory.units, 'KiB'); assert.equal(memory.actual.memory.scope, 'renderer-v8-isolate')
assert.equal(memory.actual.memory.unavailable, null)
const heap = memory.actual.memory.heap
assert.deepEqual(Object.keys(heap).sort(), ['heapLimitKib','physicalHeapKib','totalHeapKib','usedHeapKib'])
for (const value of Object.values(heap)) assert.ok(Number.isFinite(value) && value >= 0)
assert.ok(heap.usedHeapKib <= heap.totalHeapKib && heap.totalHeapKib <= heap.heapLimitKib)
assert.equal(memory.compiledIsolatedPreloadSHA256, native.compiled.find(value => value.file === 'compiled/fixture-preload.cjs')?.sha256)
if (scope === 'overview') {
  const overview = qualify(refs.overview, {minimumTests:6, mutants:10, verifier:'apps/desktop/scripts/verify-performance-attribution-overview.mjs'})
  const reviewBytes = readFileSync(refs.review), review = JSON.parse(reviewBytes)
  assert.equal(review.status, 'approved'); assert.equal(review.independent, true)
  assert.equal(review.resourcesSHA256, resource.sha256); assert.equal(review.overviewSHA256, overview.sha256)
  assert.equal(review.joinSHA256, join.sha256); assert.equal(review.nativeCaptureSHA256, sha(nativeBytes))
  assert.ok(review.frames?.length >= 4, 'Actual independent wide/narrow/theme/detail review required')
  for (const frame of review.frames) assert.equal(sha(readFileSync(frame.path)), frame.sha256, 'Reviewed actual screenshot drift')
}
process.stdout.write(JSON.stringify({passed:true,scope,boundary:'Exact source/test/caller-bound receipts reused; no repeated capture or native matrix.'})+'\n')
