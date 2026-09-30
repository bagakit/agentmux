import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOriginalReader } from '../../verify-browser-operation-feedback-native-receipt.mjs'

const repo = resolve(import.meta.dirname, '../../../../..')
const source = process.env.AGENTMUX_FEEDBACK_BINDING_CONSUMER_SOURCE ?? resolve(import.meta.dirname, '../../browser-feedback-frame-binding-receipt.mjs')
const { consumeFrameBindingIncrement, assertPaintedTweenProgress } = await import(pathToFileURL(source))
const dir = resolve(repo, 'docs/reviews/evidence/browser-operation-feedback-frame-binding-2026-10-04/native-attempt-2')
const receipt = JSON.parse(await readFile(resolve(dir, 'receipt.json'), 'utf8'))
const original = await createOriginalReader(dir)
const historical = resolve(repo, 'docs/reviews/evidence/browser-operation-pointer-motion-native-2026-10-04/attempt-4')
let result
test('actual receipt consumes all original PNGs and real directed intermediate travel', async () => {
  result = await consumeFrameBindingIncrement(receipt, original)
  assert.equal(result.partialNativePassed, true)
  assert.equal(result.taskComplete, false)
  assert.equal(result.images.length, 5)
  assert.equal(result.movements.length, 1)
  assert.ok(result.movements[0].progress[0].fraction > 0 && result.movements[0].progress[1].fraction < 1)
  assert.ok(result.movements[0].travel > 30)
})
test('original-reader hash mismatch cannot certify substituted PNG bytes', async () => {
  const raw = JSON.parse(await original(receipt.phases[0].actualOriginal))
  await assert.rejects(original({ ...raw.cases[0].frames[0], sha256: '0'.repeat(64) }, true), assert.AssertionError)
})
test('consumer recomputes pixels even when the producer says compatible and passed', async () => {
  const oldBlank = await readFile(resolve(historical, 'first-motion-same-operation-frame-000.png'))
  const actualFrame = JSON.parse(await original(receipt.phases[0].actualOriginal)).cases[0].frames[0]
  // A controlled byte-provider fault, not a rewritten Native receipt: the real complete
  // consumer must inspect the supplied original bitmap instead of trusting JSON flags.
  const incorrectProvider = async (row, image) => row.path === actualFrame.path ? oldBlank : original(row, image)
  await assert.rejects(consumeFrameBindingIncrement(receipt, incorrectProvider), error =>
    error instanceof assert.AssertionError && /Original PNG independently contains/.test(error.message))
})
test('two colored positions caused only by hover float cannot prove a route', async () => {
  const raw = JSON.parse(await original(receipt.phases[0].actualOriginal)), row = raw.cases[0]
  const witness = row.motionWitnesses[0], frames = row.frames.slice(0, 2).map(frame => ({ ...frame, recomputed: structuredClone(frame.pixelEvidence) }))
  frames[1].recomputed.arrowPixels.cssBounds.x = frames[0].recomputed.arrowPixels.cssBounds.x
  frames[1].recomputed.arrowPixels.cssBounds.y = frames[0].recomputed.arrowPixels.cssBounds.y + 1.5
  assert.throws(() => assertPaintedTweenProgress(witness, frames), assert.AssertionError)
})
test('cached start plus floating arrow is not an actual intermediate sequence', async () => {
  const raw = JSON.parse(await original(receipt.phases[0].actualOriginal)), row = raw.cases[0]
  const witness = row.motionWitnesses[0], frames = row.frames.slice(0, 2).map(frame => ({ ...frame, recomputed: structuredClone(frame.pixelEvidence) }))
  frames[0].recomputed.arrowPixels.cssBounds.x = witness.from.x
  frames[0].recomputed.arrowPixels.cssBounds.y = witness.from.y
  assert.throws(() => assertPaintedTweenProgress(witness, frames), assert.AssertionError)
})
