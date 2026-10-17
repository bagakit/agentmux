import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runA2aProof } from './lib/a2a-proof.mjs'
import { sealReferenceDeliveryProof } from './lib/a2a-reference-proof.mjs'

const journal = ['packages/core/test/a2a-reference-delivery.test.ts']
const native = ['packages/core/test/a2a-reference-native.test.ts']

// The Runtime fixture uses an explicit verification Provider, not a simulated
// kernel. The actual Codex adapter and model adoption have their own native gate.
const compiled = await runA2aProof({
  name: 'a2a-reference-delivery', freezeTests: true,
  frozenSupport: ['packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/fixture-values.ts', 'packages/core/test/fixtures/a2a-reference/native-actor.mjs'], tests: [...journal, ...native],
  environment: ({ label, evidence, dist, url }) => ({ AGENTMUX_TEST_REFERENCE_FACTS: join(evidence, label + '-native-facts.jsonl'), AGENTMUX_TEST_REFERENCE_CORE: url('index.js'), AGENTMUX_TEST_REFERENCE_CLI: join(dist, 'agentmux.js') }),
  sourceInputs: ['packages/core/src/index.ts', 'packages/core/src/client.ts', 'packages/core/src/ctxmux-run-adapter.ts', 'packages/core/src/agent-global-message-queue.ts',
    'packages/core/src/agent-message-journal.ts', 'packages/core/src/agent-message-query.ts', 'packages/core/src/agent-message-notification.ts',
    'packages/core/src/agent-message-notifications.ts', 'packages/core/src/agent-provider.ts', 'packages/core/src/providers/codex-native-input.ts', 'packages/core/src/native-input-adoption.ts', 'packages/core/src/prompt-submission.ts', 'packages/core/src/prompt-submission-record.ts',
    'packages/core/src/agent-messaging-guidance.ts', 'packages/core/src/agentmux-cli-module-skills.ts', 'packages/core/src/agentmux-cli-help.ts', 'packages/core/src/agent-message-render.ts', 'packages/core/src/agentmux-cli-commands.ts',
    'packages/core/src/public-rpc-service.ts', 'packages/core/src/public-rpc.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/types.ts',
    'packages/core/scripts/verify-a2a-reference-delivery.mjs', 'packages/core/scripts/lib/a2a-proof.mjs', 'packages/core/scripts/lib/a2a-reference-proof.mjs',
    'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/fixtures/a2a-reference/native-actor.mjs'],
  callers: [
    { path: 'packages/core/src/agentmux-cli-commands.ts', symbol: "command('agent.send'" },
    { path: 'packages/core/src/agentmux.ts', symbol: 'client.call(method, invocation.params' },
    { path: 'packages/core/src/public-rpc-service.ts', symbol: 'recipientOwner.client.submitAgentMessage' },
    { path: 'packages/core/src/client.ts', symbol: 'this.messageNotifications.saved' },
    { path: 'packages/core/src/agent-message-notifications.ts', symbol: 'this.deps.queue.prepareNotification' },
    { path: 'packages/core/src/client.ts', symbol: 'this.submitMessageNotification' },
    { path: 'packages/core/src/prompt-submission.ts', symbol: 'prepared.send(prompt, frozenPlan)' }
  ],
  mutations: [
    { label: 'default-managed-inbox-producer', file: 'client.js', tests: native,
      before: "}, { deliveryMode: 'reference', reauthorize });", after: '}, { reauthorize });' },
    { label: 'notice-does-not-become-user-request', file: 'client.js', tests: native,
      before: 'const authored = platformNotification ? { systemContext: platformNotification.wire, a2aNotificationId: platformNotification.notificationId }',
      after: 'const authored = platformNotification ? { systemContext: platformNotification.wire, userContent: platformNotification.wire, a2aNotificationId: platformNotification.notificationId }' },
    { label: 'original-notice-run-boundary', file: 'agent-global-message-queue.js', tests: journal,
      before: "original.run_id !== notice.key.expectedRun.runId || typeof original.sender_id !== 'string'",
      after: "false || typeof original.sender_id !== 'string'" },
    { label: 'submitted-reference-leaves-pending-index', file: 'agent-global-message-queue.js', tests: journal,
      before: 'UPDATE a2a_message_notifications SET submitted=1 WHERE notification_id=?',
      after: 'UPDATE a2a_message_notifications SET submitted=0 WHERE notification_id=?' }
  ]
})

// The actual CLI/Runtime chain above cannot stand in for the Codex adapter's
// source contract; compose its owning gate and require identical shared inputs.
const result = await promisify(execFile)(process.execPath, [join(import.meta.dirname, 'verify-a2a-idle-input.mjs')], { maxBuffer: 1024 * 1024 })
const nativeGate = JSON.parse(result.stdout.trim().split('\n').at(-1))
assert.equal(nativeGate.passed, true); assert.equal(nativeGate.sourceOnly, true)
const compiledReceipt = JSON.parse(await readFile(compiled.receipt, 'utf8'))
const nativeReceipt = JSON.parse(await readFile(nativeGate.receipt, 'utf8'))
assert.equal(nativeReceipt.passed, true); assert.ok(nativeReceipt.cases.length > 0)
const shared = Object.keys(nativeReceipt.sourceBefore).filter(path => path in compiledReceipt.sourceBefore)
assert.ok(shared.length >= 5, 'The source adapter gate and compiled consumer gate must share their actual product inputs')
for (const path of shared) assert.equal(nativeReceipt.sourceBefore[path], compiledReceipt.sourceBefore[path], `Candidate changed between compiled and adapter proofs: ${path}`)
const receipt = join(dirname(compiled.receipt), 'delivery-gate.json')
await writeFile(receipt, JSON.stringify({ schema: 'agentmux.a2a-reference-delivery-gate.v1', passed: true,
  compiled: compiled.receipt, nativeSource: nativeGate.receipt, sharedInputs: shared,
  boundary: 'Actual CLI and private Runtime consumer chain, compiled behavior mutants, and separately loaded native adapter source mutants; model adoption is a separate proof.' }, null, 2) + '\n')
await sealReferenceDeliveryProof({ root: resolve(import.meta.dirname, '../../..'), receipt })
process.stdout.write(JSON.stringify({ passed: true, receipt }) + '\n')
