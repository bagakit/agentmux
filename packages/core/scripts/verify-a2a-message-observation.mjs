import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { runA2aProof } from './lib/a2a-proof.mjs'

const root = resolve(import.meta.dirname, '../../..')
const built = spawnSync('pnpm', ['--filter', '@agentmux/core...', 'build'], { cwd: root, stdio: 'inherit' })
assert.equal(built.status, 0, 'The observation proof requires this candidate to build.')

await runA2aProof({
  name: 'a2a-message-observation-proof',
  tests: ['packages/core/test/agent-message-observer.test.ts'],
  sourceInputs: ['packages/core/src/client.ts', 'packages/core/src/client-event-publisher.ts',
    'packages/core/src/agent-global-message-queue.ts', 'packages/core/src/agent-message-journal.ts',
    'packages/core/src/agent-message-observer.ts', 'packages/core/src/types.ts',
    'packages/core/test/helpers/public-rpc-owner.ts', 'packages/core/test/fixtures/message-journal-writer.mjs',
    'packages/core/scripts/verify-a2a-message-observation.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ url }) => ({ AGENTMUX_TEST_RPC_CORE_ENTRY: url('index.js') }),
  callers: [
    { symbol: 'this.observeMessageReads()?.refresh()', path: 'packages/core/src/client.ts' },
    { symbol: 'client.onEvent(event =>', path: 'packages/core/src/hosted-runtime-service.ts' },
    { symbol: "rpc.subscribe('runtime.events'", path: 'packages/core/src/hosted-client.ts' },
    { symbol: 'prepared.client.onEvent', path: 'apps/desktop/src/main/runtime-controller.ts' },
    { symbol: "event.type === 'agent-message-changed'", path: 'apps/desktop/src/renderer/src/lib/use-session-messages.ts' }
  ],
  mutations: [
    { label: 'initial-cut-subscription-gap-is-not-read', file: 'agent-message-observer.js',
      before: 'await this.check(); // Read the initial cut → OS subscription gap from the original journal.', after: '// Deliberately lose the original cut gap.' },
    { label: 'successful-observation-does-not-advance-private-cut', file: 'agent-message-observer.js',
      before: 'this.cursor = next.cut;', after: 'void next.cut;' },
    { label: 'snapshot-bypasses-original-cross-process-mutex', file: 'agent-global-message-queue.js',
      before: 'return this.withLock(async () => {\n            if (!after)',
      after: 'if (after) { const db = await openMessageJournalSnapshot(this.path); try { return read(db); } finally { db.close(); } }\n        return this.withLock(async () => {\n            if (!after)' },
    { label: 'source-replacement-or-rollback-is-accepted', file: 'agent-global-message-queue.js',
      before: 'if (after && (after.incarnation !== incarnation || maximum < after.throughSequence))',
      after: 'if (false && after && (after.incarnation !== incarnation || maximum < after.throughSequence))' },
    { label: 'firstsaved-a2a-position-is-not-indexed', file: 'agent-message-journal.js',
      before: "WHEN (json_extract(NEW.json, '$.kind') = 'message'", after: "WHEN (0 AND json_extract(NEW.json, '$.kind') = 'message'" }
  ]
})
