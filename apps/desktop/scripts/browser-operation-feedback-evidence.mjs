import assert from 'node:assert/strict'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function feedbackEvidenceBytes(path) {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const child = join(path, entry.name)
    total += entry.isDirectory() ? await feedbackEvidenceBytes(child) : (await stat(child)).size
  }
  return total
}

// Counts this writer's final artifacts, including the receipt. An outer executor must
// measure again after adding its own stdout/process/archive records.
export async function writeFeedbackReceipt(directory, receipt, limitBytes) {
  const path = join(directory, 'receipt.json')
  const previousBytes = await stat(path).then(s => s.size, error => {
    if (error.code !== 'ENOENT') throw error
    return 0
  })
  const rawBytes = await feedbackEvidenceBytes(directory) - previousBytes
  if (limitBytes !== undefined) {
    receipt.evidenceCost = { scope: 'driver-final-artifacts-before-external-execution-records', limitBytes, finalBytes: rawBytes, passed: true }
    for (let attempt = 0; attempt < 8; attempt++) {
      const finalBytes = rawBytes + Buffer.byteLength(JSON.stringify(receipt))
      const passed = finalBytes <= limitBytes
      if (!passed) {
        receipt.passed = false
        receipt.failure ??= { message: 'Final motion evidence, including durable artifacts and receipt, exceeds its byte limit.' }
      }
      if (receipt.evidenceCost.finalBytes === finalBytes && receipt.evidenceCost.passed === passed) break
      receipt.evidenceCost = { ...receipt.evidenceCost, finalBytes, passed }
    }
    assert.equal(receipt.evidenceCost.finalBytes, rawBytes + Buffer.byteLength(JSON.stringify(receipt)), 'Final receipt cost converges before writing')
  }
  await writeFile(path, JSON.stringify(receipt))
  if (limitBytes !== undefined) assert.equal(await feedbackEvidenceBytes(directory), receipt.evidenceCost.finalBytes, 'Final on-disk bytes match the receipt cost')
}
