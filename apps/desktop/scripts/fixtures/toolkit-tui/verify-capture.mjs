import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Two Toolkit gates consume one actual Native execution and its independent scope review. */
export async function readToolkitNativeProof(root) {
  const directory = resolve(root, '.local/toolkit-tui-polish/native-final')
  const read = async file => JSON.parse(await readFile(file, 'utf8'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const native = await read(resolve(directory, 'receipt.json'))
  assert.equal(native.completed, true); assert.equal(native.sourceCurrentReadbackExact, true)
  assert.equal(native.nativeCleanupConfirmed, true); assert.equal(native.privateRootRemoved, true)
  assert.deepEqual(native.remainingPrivateProcesses, [])
  const review = await read(resolve(directory, '../native-chain-review.json'))
  assert.equal(review.status, 'approved'); assert.ok(review.reviewer)
  assert.equal(review.nativeSourceIdentity, native.sourceIdentity)
  assert.ok(Object.keys(native.inputs).length > 0)
  const changed = []
  for (const [file, input] of Object.entries(native.inputs)) {
    const current = hash(await readFile(resolve(root, file)))
    if (current === input.sha256) continue
    const assessed = review.sourceChanges.find(change => change.file === file)
    assert.ok(assessed, 'Unreviewed Native source change: ' + file)
    assert.equal(assessed.capturedSHA256, input.sha256); assert.equal(assessed.currentSHA256, current)
    assert.equal(assessed.impact, 'outside-toolkit-consumer'); assert.ok(assessed.rationale)
    changed.push(file)
  }
  assert.deepEqual(review.sourceChanges.map(change => change.file).sort(), changed.sort(), 'Native impact review must match the exact observed changes')
  assert.equal(native.rawInputs.length, 1, 'One actual Native Toolkit consumer required')
  const input = native.rawInputs[0], bytes = await readFile(resolve(directory, input.file)), raw = JSON.parse(bytes)
  assert.equal(hash(bytes), input.sha256); assert.equal(raw.qualified, true); assert.equal(raw.afterDisposalLeases, 0)
  assert.equal(raw.polish.completed, true)
  return { native, raw, input, directory }
}
