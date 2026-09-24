import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// One launcher, two actual failure shapes. Each owns its ordinary quit/restart receipt.
const root = resolve(import.meta.dirname, '../../..')
assert.equal(process.argv.length, 2)
for (const kind of ['locator', 'navigation']) {
  const exit = await new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'verify-browser-recovery-restart.mjs'), `--case-local-recovery-${kind}`], { cwd: root, stdio: 'inherit' })
    child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal }))
  })
  const receipt = JSON.parse(await readFile(join(root, `.tmp/browser-local-recovery-${kind}-last.json`), 'utf8'))
  const evidence = await mkdtemp(join(root, `.tmp/browser-local-recovery-${kind}-proof-`))
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  for (const frame of receipt.visual?.frames ?? []) {
    await copyFile(frame.file, join(evidence, frame.label + '.png'))
    await copyFile(frame.nativePage.file, join(evidence, frame.label + '-native-page.png'))
  }
  console.log(JSON.stringify({ kind, evidence, exit }))
  assert.equal(exit.code, 0, JSON.stringify(receipt.failure)); assert.equal(exit.signal, null)
  assert.equal(receipt.case, 'local-recovery'); assert.equal(receipt.localRecoveryKind, kind)
  assert.equal(receipt.passed, true); assert.equal(receipt.completeGate, true)
  assert.equal(receipt.localRecovery?.complete, true); assert.equal(receipt.localRecovery.kind, kind)
  assert.equal(receipt.localRecovery.run.operationIds.length, 1)
  assert.equal(receipt.localRecovery.beforeRestart.id, receipt.localRecovery.operationId)
  assert.deepEqual(receipt.identityBefore, receipt.identityAfter)
  assert.deepEqual(receipt.firstUi.restored, receipt.secondUi.restored)
  assert.equal(receipt.firstExit.exitCode, 0); assert.equal(receipt.firstExit.signal, null)
  assert.equal(receipt.secondExit.exitCode, 0); assert.equal(receipt.secondExit.signal, null)
  assert.equal(receipt.cleanup.privateProcessesReaped, true); assert.equal(receipt.cleanup.temporaryRootRemoved, true)
}
