import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, dirname, relative, resolve } from 'node:path'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const nonempty = (value, label) => { assert.ok(Array.isArray(value) && value.length > 0, label); return value }
const positive = (value, label) => assert.ok(Number.isSafeInteger(value) && value > 0, label)
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

async function original(root, value, image = false) {
  assert.ok(value && typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'Original path/SHA are explicit')
  const path = await realpath(isAbsolute(value.path) ? value.path : resolve(root, value.path))
  const rel = relative(root, path)
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Original stays inside this exact evidence root')
  const bytes = await readFile(path)
  assert.ok(bytes.length > 0); assert.equal(bytes.length, value.bytes, 'Original bytes are bound'); assert.equal(sha(bytes), value.sha256, 'Original SHA is bound')
  if (image) assert.deepEqual(bytes.subarray(0, 8), png, 'Native image is an original PNG')
  return bytes
}
function operations(row, run) {
  const ids = nonempty(run.operationIds, 'Actual task operation IDs are nonempty')
  assert.equal(new Set(ids).size, ids.length)
  const actual = nonempty(row.operations, 'Actual original journal operations are nonempty')
  for (const id of ids) {
    const matches = actual.filter(operation => operation.id === id)
    assert.equal(matches.length, 1, 'Original operation has one exact journal fact')
    const operation = matches[0]
    assert.equal(operation.browserId, run.browserId); assert.equal(operation.phase, 'completed')
    assert.ok(Number.isFinite(operation.startedAt) && Number.isFinite(operation.finishedAt) && operation.finishedAt >= operation.startedAt)
    nonempty(operation.steps, 'Actual operation consumed real page SDK steps')
  }
  const mapping = nonempty(run.stepExecutions, 'Original selected step/operation mapping is nonempty')
  assert.deepEqual(mapping.map(fact => fact.operationId), ids)
}
export function assertTaskBatchNativeCase(row) {
  assert.equal(row.kind, 'batch')
  const batch = row.response?.batch
  assert.ok(batch && row.publicMethod === 'browser.task.batch', 'Actual public batch response exists')
  const declared = nonempty(row.assetVersion?.steps, 'Actual immutable version is nonempty')
  assert.ok(declared.length >= 2)
  assert.equal(batch.version, row.assetVersion.version); assert.equal(batch.status, 'completed'); assert.equal(batch.nextItem, 2)
  assert.equal(batch.items?.length, 2); assert.equal(new Set(batch.items.map(item => item.id)).size, 2)
  const runs = nonempty(row.runs, 'Actual two item runs are nonempty'); assert.equal(runs.length, 2)
  assert.deepEqual(runs.map(run => run.id), batch.items.map(item => item.runId))
  for (const run of runs) {
    assert.ok(run.id && run.assetId && run.browserId); assert.equal(run.assetId, batch.assetId); assert.equal(run.version, batch.version); assert.equal(run.browserId, batch.browserId)
    assert.equal(run.status, 'completed'); assert.deepEqual(row.state.runs.find(actual => actual.id === run.id), run); operations(row, run)
  }
  assert.equal(batch.operationCount, runs.reduce((sum, run) => sum + run.operationIds.length, 0)); assert.ok(batch.operationCount <= 256)
  assert.equal(batch.executedMillis, runs.reduce((sum, run) => sum + run.executedMillis, 0)); assert.ok(batch.executedMillis >= 0 && batch.executedMillis <= 120000)
  assert.ok(Array.isArray(row.before?.state?.items) && Array.isArray(row.after?.state?.items))
  assert.deepEqual(row.after.state.items.slice(row.before.state.items.length), [`${row.label}-one`, `${row.label}-two`], 'Native page consumed both exact original item values once')
  assert.equal(row.after.state.items.length - row.before.state.items.length, 2)
}
export function assertTaskBranchNativeCase(row) {
  assert.equal(row.kind, 'branch'); assert.ok(['true', 'false', 'unknown'].includes(row.expected))
  const run = row.response?.run
  assert.ok(run && row.publicMethod === 'browser.task.run', 'Actual public branch response exists')
  assert.ok(run.id && run.assetId && run.browserId); assert.equal(run.version, row.assetVersion?.version)
  const originalRun = row.state.runs.find(actual => actual.id === run.id)
  assert.ok(originalRun, 'The actual Main selected run exists')
  // Trusted human approval facts are Main-owned and absent from the public typed run.
  const { humanCheckpoints, ...publicFields } = originalRun
  assert.deepEqual(publicFields, run)
  const fact = nonempty(run.branchDecisions, 'Original branch fact is nonempty')[0]
  assert.equal(fact.result, row.expected); assert.ok(fact.operationId && fact.stepId && fact.navigationId)
  assert.equal(fact.navigationId, row.currentNavigationId, 'Original condition belongs to the current native navigation')
  assert.equal(run.status, row.expected === 'unknown' ? 'ready' : 'completed')
  assert.equal(row.after?.state?.then - row.before?.state?.then, row.expected === 'true' ? 1 : 0, 'Only the actual chosen true arm runs')
  assert.equal(row.after?.state?.else - row.before?.state?.else, row.expected === 'false' ? 1 : 0, 'Only the actual chosen false arm runs')
  assert.equal(run.stepExecutions?.length, row.expected === 'unknown' ? 1 : 2)
  assert.deepEqual(run.stepExecutions.map(fact => fact.stepId), row.expected === 'unknown' ? ['condition'] : ['condition', row.expected === 'true' ? 'then' : 'else'])
  assert.equal(fact.operationId, run.stepExecutions[0].operationId); operations(row, run)
}
export function assertTaskCheckpointNativeCase(row, task) {
  assert.equal(row.kind, task === 'batch' ? 'batch-checkpoint' : 'branch-checkpoint')
  assert.ok(typeof row.refusal === 'string' && row.refusal.length > 0, 'Actual Agent Continue was refused')
  const grouped = task === 'batch', original = grouped ? row.started?.batch : row.started?.run
  const stopped = grouped ? row.stopped?.batch : row.stopped?.run
  assert.ok(original?.id && stopped?.id); assert.equal(original.status, 'waiting-human'); assert.equal(stopped.status, 'stopped'); assert.equal(stopped.id, original.id)
  const runId = grouped ? original.items?.[0]?.runId : original.id
  assert.ok(runId); const waiting = nonempty(row.waiting?.runs, 'Original waiting runs are nonempty').find(run => run.id === runId)
  const after = nonempty(row.afterState?.runs, 'Original stopped runs are nonempty').find(run => run.id === runId)
  assert.ok(waiting && after); assert.equal(waiting.status, 'waiting-human'); assert.equal(after.status, 'stopped')
  assert.equal(waiting.pendingCheckpointId, 'person'); assert.equal(waiting.humanCheckpoints?.length, 0); assert.equal(after.humanCheckpoints?.length, 0)
  assert.deepEqual(after.operationIds, waiting.operationIds)
  assert.equal(row.after?.state?.then - row.before?.state?.then, 1); assert.equal(row.after?.state?.else - row.before?.state?.else, 0)
  if (grouped) { assert.equal(stopped.nextItem, 0); assert.equal(stopped.items.length, 2); assert.equal(stopped.items[1].runId, undefined) }
  operations(row, after)
}
export function assertTaskNativeImageBinding(row, images) {
  positive(row.originalWebContentsId, 'The actual case WebContents exists')
  const bound = nonempty(images, 'Actual case images are nonempty').filter(image => image.label === row.imageLabel && image.webContentsId === row.originalWebContentsId)
  assert.equal(bound.length, 1, 'Actual case is bound to its one native page image')
  const image = bound[0], page = row.after ?? row.restored?.afterIdle
  assert.ok(page?.state && typeof page.url === 'string' && page.url.length > 0, 'Actual case page result exists')
  assert.equal(image.before?.url, page.url); assert.equal(image.after?.url, page.url)
  assert.deepEqual(image.before?.state, page.state, 'Capture starts on the actual case page result')
  assert.deepEqual(image.after?.state, page.state, 'Capture finishes on the actual case page result')
  assert.ok(Number.isFinite(image.startedAt) && Number.isFinite(image.returnedAt) && image.returnedAt >= image.startedAt)
  assert.equal(image.windowFocused, false); assert.equal(row.windowFocused, false)
}
export function assertTaskBoundedNativeRecovery(first, second) {
  positive(first.pid, 'The original process PID exists'); positive(second.pid, 'The restored process PID exists')
  assert.notEqual(first.pid, second.pid, 'Ordinary restore uses two real private processes')
  const retained = first.retained, restored = second.restored
  for (const state of [retained, restored]) {
    assert.ok(state?.browser && typeof state.browser.id === 'string' && state.browser.id && typeof state.browser.profileId === 'string' && state.browser.profileId && typeof state.browser.url === 'string' && state.browser.url, 'Original Browser/profile identity exists')
    nonempty(state.state?.assets, 'Original durable assets are nonempty'); nonempty(state.state?.runs, 'Original durable runs are nonempty')
    nonempty(state.publicState?.runs, 'Actual public restored runs are nonempty')
    nonempty(state.page?.state?.items, 'Actual retained native page results are nonempty')
  }
  assert.deepEqual(restored.browser, retained.browser)
  assert.deepEqual(restored.state, retained.state)
  assert.deepEqual(restored.publicState, retained.publicState)
  assert.deepEqual(restored.page.state, retained.page.state)
  assert.deepEqual(restored.afterIdle?.state, retained.page.state, 'Ordinary restore does not replay native page actions')
}
export async function readTaskBoundedNativeReceipt(path, task) {
  assert.ok(['batch', 'branch'].includes(task)); const root = await realpath(dirname(resolve(path)))
  const receiptBytes = await readFile(path), receipt = JSON.parse(receiptBytes.toString())
  assert.equal(receipt.schema, 'agentmux.browser-task-bounded-native.v1', 'A real bounded-task producer schema is required')
  assert.equal(receipt.privateProofPassed, true); assert.equal(receipt.taskComplete, false)
  assert.equal(receipt.desktopTabRegionFocusRestore, 'not-tested'); assert.equal(receipt.healthyCoreRunRestore, 'not-tested')
  assert.ok(/^[a-f0-9]{40}$/.test(receipt.source?.candidate?.commit) && /^[a-f0-9]{40}$/.test(receipt.source.candidate.tree))
  assert.equal(receipt.source.candidate.uncommittedPeerSourceConsumed, false); assert.deepEqual(receipt.source.drift, [])
  await original(root, receipt.source.bundle)
  const sources = nonempty(receipt.source.inputs, 'Actual compiled Source inputs are nonempty')
  for (const source of sources) await original(root, { path: source.snapshot, bytes: source.bytes, sha256: source.sha256 })
  for (const name of ['browser-task-assets.ts', 'browser-task-control.ts', 'browser-task-' + task + '.ts', 'browser-view-manager.ts'])
    assert.ok(sources.some(source => source.relativePath === 'apps/desktop/src/main/' + name), 'Actual owning production consumer was compiled: ' + name)
  const phases = nonempty(receipt.phases, 'Actual private processes are nonempty'); assert.deepEqual(phases.map(row => row.phase), ['first', 'second'])
  const actual = []
  for (const phase of phases) {
    assert.equal(phase.process?.exitCode, 0); assert.equal(phase.process?.timedOut, false); assert.equal(phase.process?.interruption, null)
    const value = JSON.parse((await original(root, phase.actualOriginal)).toString()); actual.push(value)
    assert.equal(value.schema, 'agentmux.browser-task-bounded-private-process.v1'); assert.equal(value.phase, phase.phase)
    positive(value.pid, 'Actual process PID exists'); assert.equal(value.phaseCompleted, true); assert.equal(value.privateCasesPassed, true); assert.equal(value.versions?.electron, '43.7.7')
    assert.equal(value.observationCondition?.windowShown, false); assert.equal(value.observationCondition?.windowFocused, false)
    nonempty(value.cases, 'Actual Native cases are nonempty'); nonempty(value.publicRequests, 'Actual public requests are nonempty')
    const images = nonempty(value.nativePages, 'Actual original Native images are nonempty')
    for (const image of images) { positive(image.webContentsId, 'Actual native WebContents identity exists'); assert.equal(image.windowFocused, false); await original(root, image, true) }
    for (const row of value.cases) {
      assertTaskNativeImageBinding(row, images)
    }
  }
  const cases = actual[0].cases.filter(row => row.kind === task); nonempty(cases, 'Task Native cases are nonempty')
  if (task === 'batch') { assert.deepEqual(cases.map(row => row.label), ['form-two-items', 'panel-two-items']); for (const row of cases) assertTaskBatchNativeCase(row) }
  else {
    assert.deepEqual(cases.map(row => [row.conditionKind, row.expected]), [['page-url-is', 'true'], ['page-url-is', 'false'], ['element-present', 'true'], ['element-present', 'false'], ['element-present', 'unknown']])
    for (const row of cases) assertTaskBranchNativeCase(row)
  }
  const checkpoints = actual[0].cases.filter(row => row.kind === task + '-checkpoint'); assert.equal(checkpoints.length, 1); assertTaskCheckpointNativeCase(checkpoints[0], task)
  assertTaskBoundedNativeRecovery(actual[0], actual[1])
  assert.equal(receipt.cleanup?.ownedPrivateRootRemoved, true)
  return { receipt, receiptSha256: sha(receiptBytes), actual, cases }
}
export async function taskNativeReceiptCli(task) {
  const index = process.argv.indexOf('--receipt'), path = index < 0 ? undefined : process.argv[index + 1]
  if (!path) { console.log(JSON.stringify({ status: 'pending', reason: 'An actual producer receipt is required', taskComplete: false })); process.exitCode = 2; return }
  try {
    const result = await readTaskBoundedNativeReceipt(path, task)
    console.log(JSON.stringify({ status: 'pending', task, privateTechnicalProof: true, receiptSha256: result.receiptSha256, taskComplete: false,
      reason: 'Actual private owner/page/ordinary-profile proof was consumed. Independent Native image review, OS and complete Desktop/healthy Run restore are not provided; their actual full adapter remains pending.' }))
    process.exitCode = 2
  } catch (error) {
    console.log(JSON.stringify({ status: error.code === 'ENOENT' ? 'pending' : 'rejected', reason: error.message, taskComplete: false })); process.exitCode = error.code === 'ENOENT' ? 2 : 1
  }
}
