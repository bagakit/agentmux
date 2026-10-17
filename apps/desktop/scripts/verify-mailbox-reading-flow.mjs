import assert from 'node:assert/strict'
import { runProbeProcess } from './probe-process.mjs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mailboxMutations } from './fixtures/mailbox-reading-flow/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const base = join(root, '.tmp/mailbox-reading-flow')
const receiptPath = join(base, 'receipt.json')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const prepare = process.argv.slice(2).includes('--prepare')
assert.ok(process.argv.slice(2).every(value => value === '--prepare'), 'Use --prepare for the owning source/bridge proof; no arguments verify it. Actual product reading belongs to verify-a2a-reference-reading.mjs.')
const tests = ['apps/desktop/test/session-mailbox-author-boundary.test.tsx', 'apps/desktop/test/mailbox-a2a.test.tsx', 'apps/desktop/test/session-mailbox-a2a.test.tsx',
  'apps/desktop/test/session-messages-read.test.tsx', 'apps/desktop/test/session-mailbox.test.tsx',
  'apps/desktop/test/session-mailbox-reading-flow.test.tsx', 'apps/desktop/test/session-mailbox-receipts.test.tsx',
  'apps/desktop/test/conversation-message-wrapper.integration.test.tsx', 'apps/desktop/test/input-mailbox-body-boundary.test.tsx',
  'apps/desktop/test/input-history-agent-aliases.test.tsx']
const sources = [...new Set([...tests, ...mailboxMutations.map(item => item.file),
  'apps/desktop/src/renderer/src/components/MailboxReading.tsx',
  'apps/desktop/src/renderer/src/lib/session-mailbox-messages.ts',
  'apps/desktop/src/renderer/src/lib/use-service-notices.ts',
  'packages/client-ui/src/styles/composer.css',
  'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ConversationInputText.tsx',
  'packages/client-ui/src/components/ConversationResourceText.tsx',
  'packages/client-ui/src/lib/use-agent-input-history.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/ipc-sender-trust.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/test/a2a-message-data-bridge.test.tsx', 'apps/desktop/test/vitest.a2a-message-data.config.mts',
  'apps/desktop/test/helpers/mailbox-journal-fixture.ts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'apps/desktop/scripts/fixtures/conversation-message-wrapper/inputs.mjs',
  'apps/desktop/scripts/fixtures/mailbox-reading-flow/vitest.config.mts',
  'apps/desktop/scripts/fixtures/mailbox-reading-flow/mutations.mjs',
  'apps/desktop/scripts/verify-mailbox-reading-flow.mjs'])]
const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(join(root, file)))])))
async function execute(args, { label, evidence, env = {}, report = false, expectedRed = false } = {}) {
  const directory = join(evidence, label); await mkdir(directory, { recursive: true })
  const lines = []
  const processReceipt = await runProbeProcess(process.execPath, args, {
    temporaryRoot: directory, cwd: root,
    env: { ...process.env, ...env, AGENTMUX_TEST_MAILBOX_ARTIFACT: directory },
    timeoutMs: 120_000, onLine: line => lines.push(line)
  })
  await writeFile(join(directory, 'run.log'), lines.join('\n'))
  assert.equal(processReceipt.timedOut, false, label + ': an interrupted proof cannot qualify')
  assert.equal(processReceipt.interruption, null)
  assert.equal(processReceipt.exitConfirmed, true)
  const result = { exit: processReceipt.exitCode, signal: processReceipt.exitSignal, process: processReceipt }
  if (!report) { assert.equal(result.exit, 0, label + ': see run.log'); return { ...result, directory } }
  const parsed = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
  assert.ok(parsed.numTotalTests > 0, label + ': executed scenarios are nonempty')
  const failures = parsed.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  if (expectedRed) {
    assert.ok(result.exit > 0 && failures.some(test => test.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__/.test(message))), label + ': a real behavior assertion must fail')
  } else {
    assert.equal(result.exit, 0, label + ': baseline/restoration must pass')
    assert.equal(parsed.numFailedTests, 0); assert.equal(parsed.success, true)
  }
  return { ...result, tests: parsed.numTotalTests, failed: parsed.numFailedTests, directory }
}
function testArgs(selected, directory, config = 'apps/desktop/scripts/fixtures/mailbox-reading-flow/vitest.config.mts') {
  return [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, ...selected,
    '--maxWorkers=1', ...(config.endsWith('vitest.a2a-message-data.config.mts') ? ['--reporter=default', '--reporter=json'] : []),
    '--outputFile=' + join(directory, 'results.json')]
}
if (prepare) {
  const evidence = join(base, 'a2a-' + Date.now())
  await mkdir(evidence, { recursive: true })
  const receipt = { schema: 'agentmux.mailbox-reading-source-proof.v1', sourceOnly: true, prepared: false, passed: false, evidence, sharedSourceWritten: false, mutations: [] }
  try {
    receipt.sourceBefore = await sourceHashes()
    for (const item of mailboxMutations) assert.equal((await readFile(join(root, item.file), 'utf8')).split(item.before).length, 2, 'Unique production mutation anchor: ' + item.label)
    const runTests = (label, selected, env = {}, expectedRed = false, config) => execute(testArgs(selected, join(evidence, label), config), { label, evidence, env, report: true, expectedRed })
    // Resolve the registered Main/preload/SDK graph before repeating leaf mutations.
    const bridgeTests = ['apps/desktop/test/a2a-message-data-bridge.test.tsx'], bridgeConfig = 'apps/desktop/test/vitest.a2a-message-data.config.mts'
    receipt.bridge = await runTests('actual-data-bridge', bridgeTests, {}, false, bridgeConfig)
    receipt.baseline = await runTests('baseline', tests)
    for (const item of mailboxMutations) {
      const red = await runTests(item.label + '-red', item.tests, { AGENTMUX_TEST_MAILBOX_MUTATION: item.label }, true)
      const restored = await runTests(item.label + '-restored', item.tests)
      receipt.mutations.push({ label: item.label, red, restored })
    }
    for (const mutation of ['participant', 'readParticipant', 'preload', 'messageId']) {
      const red = await runTests('bridge-' + mutation + '-red', bridgeTests, { AGENTMUX_TEST_MESSAGE_DATA_MUTATION: mutation }, true, bridgeConfig)
      const restored = await runTests('bridge-' + mutation + '-restored', bridgeTests, {}, false, bridgeConfig)
      receipt.mutations.push({ label: 'bridge-' + mutation, red, restored })
    }
    receipt.types = await execute([join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'apps/desktop/tsconfig.json'], { label: 'desktop-types', evidence })
    receipt.sourceAfter = await sourceHashes()
    assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'The actual source candidate stays unchanged during preparation')
    receipt.prepared = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  assert.equal(receipt.prepared, true, receipt.failure?.message)
  console.log(JSON.stringify({ prepared: true, receipt: receiptPath, suites: tests.length, tests: receipt.baseline.tests, mutations: receipt.mutations.length,
    sourceOnly: true, boundary: 'Owning Mailbox source and public data bridge. Actual product and independent images belong to verify-a2a-reference-reading.mjs.' }))
} else {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  assert.equal(receipt.schema, 'agentmux.mailbox-reading-source-proof.v1'); assert.equal(receipt.sourceOnly, true)
  assert.equal(receipt.prepared, true, 'Prepare the exact candidate and preserve its actual failures before signing off')
  assert.deepEqual(await sourceHashes(), receipt.sourceAfter, 'The owning reading proof belongs to this exact candidate')
  assert.equal(receipt.mutations.length, mailboxMutations.length + 4)
  for (const mutation of receipt.mutations) { assert.ok(mutation.red.failed > 0); assert.equal(mutation.restored.exit, 0) }
  console.log(JSON.stringify({ passed: true, receipt: receiptPath, sourceInputs: sources.length, suites: tests.length, tests: receipt.baseline.tests,
    mutations: receipt.mutations.length, sourceOnly: true }))
}
