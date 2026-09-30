import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function inspectReceiptOriginal(path) {
  const originalPath = resolve(path), bytes = await readFile(originalPath)
  const receipt = JSON.parse(bytes.toString('utf8'))
  assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'A receipt is a nonempty record')
  assert.ok(Object.keys(receipt).length > 0, 'Receipt fields are nonempty')
  return { receipt, identity: { path: originalPath, bytes: bytes.length, sha256: sha(bytes) } }
}

export async function verifyTextEditNativeReceipt(args = []) {
  const report = {
    schema: 'agentmux.browser-text-edit-native-consumer.v1', taskId: 'T-027',
    scope: 'readonly-native-entry', passed: false, nativePassed: false, taskComplete: false,
    adapterImplemented: false, outcome: 'pending', actions: [], evidence: null,
    reason: 'No actual text-edit Native receipt was provided.',
    missing: [
      'Actual text-edit Native producer and producer-specific action adapter (internal TODO)',
      'Candidate/load Source and compiled originals bound to the actual process/window/WebContents/frame/input',
      'Original native menu/shortcut editing results, selection and stale-target zero-edit evidence',
      'Original WebContents and exact-PID OS menu PNGs with independent review'
    ]
  }
  try {
    if (args.length) {
      assert.ok(args.length === 2 && args[0] === '--receipt' && args[1], 'Only --receipt <original.json> is accepted')
      const { receipt, identity } = await inspectReceiptOriginal(args[1])
      report.evidence = { ...identity, producerSchema: typeof receipt.schema === 'string' ? receipt.schema : null,
        reportedPassed: receipt.passed === true ? true : receipt.passed === false ? false : 'unknown' }
      report.outcome = 'unsupported'
      report.reason = 'The exact original was read. No actual T027 producer protocol/action adapter exists yet; Source/compiled/target/edit-result/image/review relationships have not been consumed. Other Browser receipts and JSON success flags cannot certify text editing.'
    }
  } catch (error) {
    report.outcome = error.code === 'ENOENT' ? 'pending' : 'rejected'
    report.reason = error.code === 'ENOENT' ? 'The supplied actual receipt does not exist.' :
      error instanceof SyntaxError ? 'The supplied receipt is invalid JSON.' : error.message
    report.failure = { code: error.code ?? error.name }
  }
  return report
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node apps/desktop/scripts/verify-browser-text-edit-native-receipt.mjs [--receipt <original.json>]\n' +
      'Read-only acceptance entry. Missing/unsupported/invalid evidence stays pending or rejected (exit 2). No Native action, clipboard, build, install or restart. Original binding and the actual T027 action adapter remain internal TODO.\n')
    return
  }
  process.stdout.write(JSON.stringify(await verifyTextEditNativeReceipt(args), null, 2) + '\n')
  process.exitCode = 2
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main(process.argv.slice(2))
