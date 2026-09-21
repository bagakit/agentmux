import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const result = await new Promise((done, fail) => {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'verify-browser-recovery-restart.mjs'), '--case-demonstration'], { cwd: root, stdio: 'inherit' })
  child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal }))
})
const receipt = JSON.parse(await readFile(join(root, '.tmp/browser-demonstration-last.json'), 'utf8'))
const evidence = join(root, 'docs/reviews/evidence/browser-task-capabilities-2026-10-03/t010-product')
await mkdir(evidence, { recursive: true })
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
for (const frame of receipt.visual?.frames ?? []) {
  await copyFile(frame.file, join(evidence, frame.label + '.png'))
  await copyFile(frame.nativePage.file, join(evidence, frame.label + '-native-page.png'))
}
assert.equal(result.code, 0, JSON.stringify(receipt.failure)); assert.equal(result.signal, null)
assert.equal(receipt.case, 'demonstration'); assert.equal(receipt.completeGate, true)
assert.equal(receipt.demonstration?.complete, true)
assert.ok(receipt.demonstration.stopped.steps.length > 0)
assert.equal(receipt.demonstration.noAutomaticRecording, true)
assert.equal(receipt.demonstration.syntheticStartRejected, true)
assert.equal(receipt.demonstration.syntheticStopRejected, true)
assert.deepEqual(receipt.identityBefore, receipt.identityAfter)
assert.equal(receipt.cleanup.privateProcessesReaped, true)
console.log(JSON.stringify({ passed: true, evidence, aestheticReview: 'not-performed', physicalDeviceTested: false }))
