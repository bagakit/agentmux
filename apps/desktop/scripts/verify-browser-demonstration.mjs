import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const result = await new Promise((done, fail) => {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'verify-browser-recovery-restart.mjs'), '--case-demonstration', ...(process.argv.includes('--diagnose-target') ? ['--diagnose-demonstration-target'] : [])], { cwd: root, stdio: 'inherit' })
  child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal }))
})
const receipt = JSON.parse(await readFile(join(root, '.tmp/browser-demonstration-last.json'), 'utf8'))
const evidence = await mkdtemp(join(root, '.tmp/browser-demonstration-proof-'))
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
assert.equal(receipt.case, 'demonstration'); assert.equal(receipt.completeGate, true)
assert.equal(receipt.demonstration?.complete, true)
assert.ok(receipt.demonstration.stopped.steps.length > 0)
assert.equal(receipt.demonstration.noAutomaticRecording, true)
assert.equal(receipt.demonstration.syntheticStartRejected, true)
assert.equal(receipt.demonstration.syntheticStopRejected, true)
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
