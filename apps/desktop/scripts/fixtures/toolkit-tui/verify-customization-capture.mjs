import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Consume one exact native personalization capture; never starts a window or rebuilds. */
export async function verifyCustomizationCapture(root, reviewFile, requiredFrames) {
  const directory = resolve(root, '.local/toolkit-customization/native')
  const receiptBytes = await readFile(resolve(directory, 'receipt.json')), capture = JSON.parse(receiptBytes)
  assert.equal(capture.completed, true); assert.equal(capture.sourceCurrentReadbackExact, true)
  assert.equal(capture.actualApp, true); assert.equal(capture.actualSettings, true); assert.equal(capture.actualTerminalView, true)
  assert.equal(capture.toolkitScene, 'customization'); assert.equal(capture.privateRootRemoved, true)
  assert.equal(capture.nativeCleanupConfirmed, true); assert.deepEqual(capture.remainingPrivateProcesses, [])
  assert.ok(Object.keys(capture.inputs).length > 0 && capture.compiled.length > 0 && capture.rawInputs.length > 0)
  assert.equal(sha(JSON.stringify(capture.inputs)), capture.sourceIdentity)
  for (const [path, input] of Object.entries(capture.inputs)) {
    const bytes = await readFile(resolve(root, path))
    assert.equal(sha(bytes), input.sha256, 'Native candidate changed: ' + path); assert.equal(bytes.length, input.bytes)
  }
  for (const artifact of [...capture.compiled, ...capture.rawInputs]) {
    const bytes = await readFile(resolve(directory, artifact.file))
    assert.equal(sha(bytes), artifact.sha256, 'Captured artifact changed: ' + artifact.file)
    assert.equal(bytes.length, artifact.bytes)
  }
  const raw = JSON.parse(await readFile(resolve(directory, capture.rawInputs[0].file)))
  assert.equal(raw.qualified, true); assert.equal(raw.scene, 'customization'); assert.equal(raw.native.shutdown, true)
  assert.equal(raw.afterDisposalLeases, 0); assert.deepEqual(raw.cleanupErrors ?? [], [])
  const { restart, saveFailure } = raw.customization
  assert.ok(restart.beforePid > 0 && restart.afterPid > 0 && restart.beforePid !== restart.afterPid)
  assert.ok(restart.originalNativePid > 0); assert.equal(restart.originalNativePid, restart.restoredNativePid)
  assert.deepEqual(restart.originalRun, restart.restoredRun); assert.deepEqual(restart.beforeRestart, restart.restored)
  assert.equal(saveFailure.originalWarningVisible, true); assert.equal(saveFailure.inputPreserved, true); assert.equal(saveFailure.originalRetryConverged, true)
  const review = JSON.parse(await readFile(resolve(root, reviewFile)))
  assert.equal(review.verdict, 'pass'); assert.deepEqual(review.mustFix, [])
  assert.equal(review.sourceIdentity, capture.sourceIdentity)
  assert.equal(review.captureSHA256, sha(receiptBytes))
  assert.ok(review.reviewer && review.report && Array.isArray(review.images))
  assert.equal(sha(await readFile(resolve(root, review.report.file))), review.report.sha256)
  for (const frame of capture.frames) {
    assert.equal(sha(await readFile(resolve(directory, frame.file))), frame.sha256, 'Screenshot bytes remain exact: ' + frame.file)
  }
  for (const file of requiredFrames) {
    const captured = capture.frames.find(frame => frame.file === file), viewed = review.images.find(frame => frame.file === file)
    assert.ok(captured && viewed, 'The independent reviewer actually viewed ' + file)
    assert.equal(viewed.sha256, captured.sha256)
  }
  return { capture, raw, review }
}
