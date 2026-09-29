import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Read-only boundary. A complete Desktop producer has not supplied a T025 receipt
// protocol yet; raw JSON flags cannot certify OS input or ordinary Run recovery.
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: node apps/desktop/scripts/verify-browser-nonactivating-cli.mjs [--receipt <external-original.json>]\n' +
    'No build, packaging, installation, restart or GUI actions. Missing or unsupported external evidence stays pending (exit 2).\n')
} else {
  const report = { schema: 'agentmux.browser-nonactivating-cli-native-consumer.v1', taskId: 'T-025',
    passed: false, taskComplete: false, outcome: 'pending', scope: 'external-complete-desktop',
    actions: [], evidence: null, reason: 'No external complete Desktop T025 evidence was provided.',
    missing: ['Producer-specific original source/compiled/process receipt adapter', 'Actual public CLI website results and unchanged system window/Tab/Region/input owner',
      'Late completion/Unknown retention with original native input and independent image review',
      'Two real complete Desktop processes: same durable layout/profile and same healthy Session/Run recovery'] }
  try {
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--receipt' || !args[1]) throw new Error('Only --receipt <external-original.json> is accepted.')
      const path = resolve(args[1]), bytes = await readFile(path), original = JSON.parse(bytes.toString())
      report.evidence = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        producerSchema: typeof original?.schema === 'string' ? original.schema : null }
      report.outcome = 'unsupported'
      report.reason = 'Original receipt was read, but no actual complete Desktop T025 producer protocol/adapter exists yet. Its source, compiled, OS input, original images/review and ordinary recovery have not been consumed. Thin BVM receipts and JSON success flags cannot substitute.'
    }
  } catch (error) {
    report.outcome = 'unsupported'; report.reason = error.message
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = 2
}
