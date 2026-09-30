import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consumeHistoryComponentEvidence } from './browser-input-history-component-evidence.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

async function inspectHistoryReceiptOriginal(path) {
  const originalPath = resolve(path), bytes = await readFile(originalPath)
  const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'A receipt is a nonempty record')
  assert.ok(Object.keys(receipt).length > 0, 'Receipt fields are nonempty')
  return { receipt, identity: { path: originalPath, bytes: bytes.length, sha256: sha(bytes) } }
}

export async function verifyInputHistoryNativeReceipt(args = []) {
  const report = {
    schema: 'agentmux.browser-input-history-native-consumer.v1', taskId: 'T-026',
    scope: 'readonly-entry-and-original-integrity', passed: false, nativePassed: false, taskComplete: false,
    adapterImplemented: false, outcome: 'pending', actions: [], evidence: null,
    reason: 'No actual input-history Native receipt was provided.',
    missing: [
      'Complete product input-history Native producer/result adapter (internal TODO; the thin component probe is partial)',
      'Candidate/load Source and compiled originals bound to actual process/window/WebContents/input',
      'Actual human history/draft/IME/scope results in four input locations, two-process save/recovery/deletion',
      'Normal/narrow/short original page and uncovered input, original PNGs and independent visual review'
    ]
  }
  try {
    if (args.length) {
      assert.ok([2, 4].includes(args.length) && args[0] === '--receipt' && typeof args[1] === 'string' && args[1] && !args[1].startsWith('--') &&
        (args.length === 2 || args[2] === '--visual-review' && typeof args[3] === 'string' && args[3] && !args[3].startsWith('--')),
        'Only --receipt <original.json> [--visual-review <review.json>] is accepted')
      const { receipt, identity } = await inspectHistoryReceiptOriginal(args[1])
      report.evidence = { ...identity, producerSchema: typeof receipt.schema === 'string' ? receipt.schema : null,
        reportedPassed: receipt.passed === true ? true : receipt.passed === false ? false : 'unknown' }
      report.outcome = 'unsupported'
      report.reason = 'The exact original was read. A complete T026 product Native result adapter remains pending; Node proof, foreign receipts and JSON success flags cannot certify input history Native behavior.'
      if (receipt.schema === 'agentmux.browser-input-history-component-native.v1') {
        const review = args.length === 4 ? await inspectHistoryReceiptOriginal(args[3]) : null
        await consumeHistoryComponentEvidence(receipt, identity, dirname(identity.path), review, report)
        report.outcome = 'partial'
        report.reason = 'Actual shared-component/private-bridge behavior originals were consumed. Four product callers, production IPC, OS IME commit and composed-page visual acceptance remain unverified. This never signs full T026 Native acceptance.'
      }
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
    process.stdout.write('Usage: node apps/desktop/scripts/verify-browser-input-history-native-receipt.mjs [--receipt <original.json> [--visual-review <review.json>]]\n' +
      'Read-only entry and original-integrity guards. Missing/unsupported/invalid evidence stays pending or rejected (exit 2). No Native action, clipboard, build, install or restart. The actual T026 result adapter remains internal TODO.\n')
    return
  }
  process.stdout.write(JSON.stringify(await verifyInputHistoryNativeReceipt(args), null, 2) + '\n')
  process.exitCode = 2
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main(process.argv.slice(2))
