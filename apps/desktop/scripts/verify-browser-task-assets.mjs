import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const result = await new Promise((done, fail) => {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'verify-browser-recovery-restart.mjs'), '--case-task-assets'], { cwd: root, stdio: 'inherit' })
  child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal }))
})
const receipt = JSON.parse(await readFile(join(root, '.tmp/browser-task-assets-last.json'), 'utf8'))
const evidence = await mkdtemp(join(root, '.tmp/browser-task-assets-proof-'))
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
for (const frame of receipt.visual?.frames ?? []) {
  await copyFile(frame.file, join(evidence, frame.label + '.png'))
  await copyFile(frame.nativePage.file, join(evidence, frame.label + '-native-page.png'))
}
for (const frame of receipt.visual?.osFrames ?? []) {
  await copyFile(frame.file, join(evidence, frame.label + '-os-compositor.png'))
  await copyFile(frame.stateFile, join(evidence, frame.label + '-os-state.json'))
}
console.log(JSON.stringify({ receipt: join(evidence, 'receipt.json') }))
assert.equal(result.code, 0, JSON.stringify(receipt.failure)); assert.equal(result.signal, null)
assert.equal(receipt.case, 'task-assets'); assert.equal(receipt.completeGate, true)
assert.equal(receipt.taskAssets?.complete, true)
assert.equal(receipt.taskAssets.deletedStepStayedDeleted, true)
assert.equal(receipt.taskAssets.immutableVersionPreserved, true)
assert.equal(receipt.taskAssets.syntheticContinueRejected, true)
assert.equal(receipt.taskAssets.waitingProjection.length, 3)
assert.equal(receipt.taskAssets.editingV2WhileWaitingV1.version, '1')
assert.equal(receipt.taskAssets.editingV2WhileWaitingV1.selectedVersion, '2')
assert.equal(receipt.taskAssets.restoredWaitingProjection.phase, 'human')
assert.equal(receipt.taskAssets.viewOnlyCheckpointEntry, true)
assert.deepEqual(receipt.taskAssets.completionChecks.map(item => item.expected), ['not-met', 'not-met', 'passed'])
assert.ok(receipt.taskAssets.version.steps.length > 0)
assert.ok(receipt.taskAssets.secretAbsentFrom.length > 0)
assert.deepEqual(receipt.identityBefore, receipt.identityAfter)
assert.equal(receipt.cleanup.privateProcessesReaped, true)
if (process.env.AGENTMUX_VISUAL_ORCA_CLI) assert.ok(receipt.visual.osFrames?.length > 0, 'Explicit OS review must contain real whole-window frames')
const publishIndex = process.argv.indexOf('--publish-evidence')
if (publishIndex >= 0) {
  const destination = process.argv[publishIndex + 1]
  assert.ok(destination, 'Publishing requires an explicit new immutable evidence directory')
  const published = resolve(root, destination)
  await mkdir(resolve(published, '..'), { recursive: true }); await mkdir(published)
  await cp(evidence, published, { force: false, errorOnExist: true })
}
console.log(JSON.stringify({ passed: true, evidence, aestheticReview: 'not-performed', physicalDeviceTested: false }))

// Consume both real completion owners through the existing launch/ordinary-restart harness.
const downloadResult = await new Promise((done, fail) => {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'verify-browser-recovery-restart.mjs'), '--case-task-outcome-download'], { cwd: root, stdio: 'inherit' })
  child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal }))
})
const downloadReceipt = JSON.parse(await readFile(join(root, '.tmp/browser-task-outcome-download-last.json'), 'utf8'))
const downloadEvidence = await mkdtemp(join(root, '.tmp/browser-task-outcome-download-proof-'))
await writeFile(join(downloadEvidence, 'receipt.json'), JSON.stringify(downloadReceipt, null, 2) + '\n')
for (const frame of downloadReceipt.visual?.frames ?? []) {
  await copyFile(frame.file, join(downloadEvidence, frame.label + '.png'))
  await copyFile(frame.nativePage.file, join(downloadEvidence, frame.label + '-native-page.png'))
}
for (const frame of downloadReceipt.visual?.osFrames ?? []) {
  await copyFile(frame.file, join(downloadEvidence, frame.label + '-os-compositor.png'))
  await copyFile(frame.stateFile, join(downloadEvidence, frame.label + '-os-state.json'))
}
assert.equal(downloadResult.code, 0, JSON.stringify(downloadReceipt.failure)); assert.equal(downloadResult.signal, null)
assert.equal(downloadReceipt.case, 'task-outcome-download'); assert.equal(downloadReceipt.completeGate, true)
assert.equal(downloadReceipt.taskDownload?.complete, true)
assert.equal(downloadReceipt.taskDownload.requests.length, 1)
assert.equal(downloadReceipt.taskDownload.requests[0].registeredBeforeProducer, true)
assert.equal(downloadReceipt.taskDownload.checks.length, 5)
for (const check of downloadReceipt.taskDownload.checks) assert.equal(check.evaluation.status, 'passed')
assert.deepEqual(downloadReceipt.identityBefore, downloadReceipt.identityAfter)
assert.equal(downloadReceipt.cleanup.privateProcessesReaped, true)
console.log(JSON.stringify({ passed: true, downloadEvidence, aestheticReview: 'not-performed', physicalDeviceTested: false }))
