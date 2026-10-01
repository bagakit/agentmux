import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { assertTaskBatchNativeCase, assertTaskBranchNativeCase, assertTaskCheckpointNativeCase,
  assertTaskNativeImageBinding, assertTaskBoundedNativeRecovery, readTaskBoundedNativeReceipt } from './browser-task-bounded-native-receipt.mjs'

const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const evidence = argument('--evidence-root')
assert.ok(evidence, 'An actual producer evidence root is required; no synthetic Native fixture is provided')
const path = resolve(evidence, 'receipt.json')
const batch = await readTaskBoundedNativeReceipt(path, 'batch'), branch = await readTaskBoundedNativeReceipt(path, 'branch')
assert.equal(batch.receiptSha256, branch.receiptSha256)
const [first, second] = batch.actual
assert.ok(first.cases.length > 0 && first.nativePages.length > 0 && second.cases.length > 0)
const actualBatch = first.cases.find(row => row.kind === 'batch')
const actualBranch = first.cases.find(row => row.kind === 'branch' && row.expected === 'true')
const actualCheckpoint = first.cases.find(row => row.kind === 'batch-checkpoint')
assert.ok(actualBatch && actualBranch && actualCheckpoint)
const passed = []
function check(name, run) { run(); passed.push(name); console.log('PASS ' + name) }
function reject(name, original, change, guard, message) {
  check(name, () => {
    const candidate = structuredClone(original); change(candidate)
    assert.throws(() => guard(candidate), error => error instanceof assert.AssertionError && message.test(error.message), name + ' must reject at its semantic assertion')
  })
}
check('actual native batch / branch / checkpoint / original-image / two-process recovery', () => {
  assertTaskBatchNativeCase(actualBatch); assertTaskBranchNativeCase(actualBranch); assertTaskCheckpointNativeCase(actualCheckpoint, 'batch')
  for (const row of first.cases) assertTaskNativeImageBinding(row, first.nativePages)
  assertTaskBoundedNativeRecovery(first, second)
})
reject('empty original operations are rejected', actualBatch, row => { row.operations = [] }, assertTaskBatchNativeCase, /Actual original journal operations are nonempty/)
reject('wrong original item operation cost is rejected', actualBatch, row => { row.response.batch.operationCount++ }, assertTaskBatchNativeCase, /strictly equal/)
reject('wrong parameter result order is rejected', actualBatch, row => { row.after.state.items.reverse() }, assertTaskBatchNativeCase, /both exact original item values once/)
reject('wrong branch navigation is rejected', actualBranch, row => { row.currentNavigationId = 'different-document' }, assertTaskBranchNativeCase, /current native navigation/)
reject('unchosen branch side effect is rejected', actualBranch, row => { row.after.state.else++ }, assertTaskBranchNativeCase, /Only the actual chosen false arm runs/)
reject('Agent-generated human approval is rejected', actualCheckpoint, row => { const id = row.started.batch.items[0].runId; row.afterState.runs.find(run => run.id === id).humanCheckpoints.push({ origin: 'agent' }) }, row => assertTaskCheckpointNativeCase(row, 'batch'), /strictly equal/)
reject('wrong case WebContents image binding is rejected', { row: actualBatch, images: first.nativePages }, value => { value.row.originalWebContentsId++ }, value => assertTaskNativeImageBinding(value.row, value.images), /one native page image/)
reject('stale native image result is rejected', { row: actualBatch, images: first.nativePages }, value => { value.images.find(image => image.label === value.row.imageLabel).before.state.items = [] }, value => assertTaskNativeImageBinding(value.row, value.images), /actual case page result/)
reject('missing both recovery identities is rejected', { first, second }, value => { delete value.first.retained; delete value.second.restored }, value => assertTaskBoundedNativeRecovery(value.first, value.second), /Original Browser\/profile identity exists/)
reject('empty both restored run collections are rejected', { first, second }, value => { value.first.retained.state.runs = []; value.second.restored.state.runs = [] }, value => assertTaskBoundedNativeRecovery(value.first, value.second), /Original durable runs are nonempty/)
reject('same process masquerading as ordinary restore is rejected', { first, second }, value => { value.second.pid = value.first.pid }, value => assertTaskBoundedNativeRecovery(value.first, value.second), /two real private processes/)
reject('restart auto-replay is rejected', { first, second }, value => { value.second.restored.afterIdle.state.then++ }, value => assertTaskBoundedNativeRecovery(value.first, value.second), /does not replay native page actions/)

// The original JSON and PNG bytes were read by the real consumer before these semantic clones.
const original = await readFile(path)
assert.ok(original.length > 0 && dirname(path) === resolve(evidence))
console.log(JSON.stringify({ schema: 'agentmux.browser-task-native-consumer-guards.v1', passed: true,
  receiptSha256: batch.receiptSha256, evidenceRoot: resolve(evidence), actualCaseCount: first.cases.length + second.cases.length,
  checks: passed, scope: 'read-only consumer guard Source; mutations of actual rows are not Native executions or Task completion' }))
