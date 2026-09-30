import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { feedbackEvidenceBytes, writeFeedbackReceipt } from '../../browser-operation-feedback-evidence.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'amx-feedback-cost-'))
  try { await run(root) } finally { await rm(root, { recursive: true }) }
}

test('final durable artifacts and receipt can turn a previously green phase red', () => fixture(async root => {
  await mkdir(join(root, 'durable-private-storage'))
  await writeFile(join(root, 'phase.json'), 'passed')
  assert.ok(await feedbackEvidenceBytes(root) < 100)
  await writeFile(join(root, 'durable-private-storage', 'profiles.json'), 'x'.repeat(80))
  const receipt = { passed: true, cleanup: { privateRootRemoved: true } }
  await writeFeedbackReceipt(root, receipt, 100)
  const actual = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'))
  assert.equal(actual.passed, false)
  assert.equal(actual.evidenceCost.passed, false)
  assert.ok(actual.evidenceCost.finalBytes > actual.evidenceCost.limitBytes)
  assert.equal(actual.evidenceCost.finalBytes, await feedbackEvidenceBytes(root))
  assert.equal(await readFile(join(root, 'durable-private-storage', 'profiles.json'), 'utf8'), 'x'.repeat(80))
}))

test('exact final-byte boundary passes; one fewer byte fails without replacing original failure', () => fixture(async root => {
  await writeFile(join(root, 'raw.json'), 'original')
  const receipt = { passed: true }
  await writeFeedbackReceipt(root, receipt, 999)
  const exactLimit = receipt.evidenceCost.finalBytes
  const exact = { passed: true }
  await writeFeedbackReceipt(root, exact, exactLimit)
  // The three-digit numeric limit preserves the exact serialization size.
  const convergedLimit = exact.evidenceCost.finalBytes
  const boundary = { passed: true }
  await writeFeedbackReceipt(root, boundary, convergedLimit)
  assert.equal(boundary.evidenceCost.finalBytes, convergedLimit)
  assert.equal(boundary.passed, true)
  assert.equal(boundary.evidenceCost.passed, true)
  const oneByteOver = { passed: true }
  await writeFeedbackReceipt(root, oneByteOver, convergedLimit - 1)
  assert.equal(oneByteOver.passed, false)
  assert.equal(oneByteOver.evidenceCost.passed, false)
  const failed = { passed: false, failure: { message: 'Original native failure' } }
  await writeFeedbackReceipt(root, failed, convergedLimit - 1)
  assert.equal(failed.passed, false)
  assert.equal(failed.evidenceCost.passed, false)
  assert.equal(failed.failure.message, 'Original native failure')
  assert.equal(failed.evidenceCost.finalBytes, await feedbackEvidenceBytes(root))
}))

test('unbounded legacy receipt and symlink accounting preserve original semantics', () => fixture(async root => {
  await writeFile(join(root, 'raw.json'), 'original')
  await symlink(join(root, 'raw.json'), join(root, 'raw-link'))
  assert.equal(await feedbackEvidenceBytes(root), 8)
  const receipt = { passed: false, failure: { message: 'Not tested' } }
  await writeFeedbackReceipt(root, receipt)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8')), receipt)
  assert.equal('evidenceCost' in receipt, false)
}))
