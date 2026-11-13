import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { runAppCaptureProof } from './app-capture-proof.mjs'

const entry = resolve(import.meta.dirname, 'fixtures/app-capture/capture.ts')
const baseline = await runAppCaptureProof({ entry, label: 'capture' })
assert.ok(baseline.checks.length >= 5, 'Capture evidence must be nonempty')
for (const mutation of [
  { file: 'src/main/app-capture.ts', before: 'for (const layer of layers)', after: 'for (const layer of [] as Layer[])' },
  { file: 'src/main/app-capture.ts', before: 'layer.view.webContents.capturePage(clip,', after: 'layer.view.webContents.capturePage(undefined,' },
  { file: 'src/main/app-capture-owner.ts', before: 'return await source.capture((input as', after: "throw new Error('Removed original capture owner'); return await source.capture((input as" },
  { file: 'src/main/workbench-windows.ts', before: 'scope.windowId === this.mainId && scope.documentGeneration === this.mainGeneration && !this.main.isDestroyed()', after: 'scope.windowId === this.mainId && !this.main.isDestroyed()' }
]) {
  await assert.rejects(runAppCaptureProof({ entry, mutation, label: 'capture-mutant' }), error => Boolean(error.proofReport?.sources?.includes('actual-cli')) && /native Browser must appear|Native pixels must be bounded|Removed original capture owner|Another native document may not be captured/.test(error.message),
    `Removing this production capture branch must fail: ${mutation.file}`)
}
console.log(JSON.stringify({ passed: true, mutationsKilled: 4, checks: baseline.checks, evidence: baseline.evidence }))
