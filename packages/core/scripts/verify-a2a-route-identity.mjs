import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { runA2aProof } from './lib/a2a-proof.mjs'

// Compile this worktree before copying its artifacts. Never borrow another tree's dist.
const root = resolve(import.meta.dirname, '../../..')
const built = spawnSync('pnpm', ['--filter', '@agentmux/core...', 'build'], { cwd: root, stdio: 'inherit' })
assert.equal(built.status, 0, 'The route proof requires this candidate to build.')

await runA2aProof({
  name: 'a2a-route-identity-proof',
  tests: ['packages/core/test/a2a-route-identity.test.ts', 'packages/core/test/a2a-local-hosted-route.test.ts'],
  sourceInputs: ['packages/core/src/public-rpc-service.ts', 'packages/core/src/agent-message-route.ts',
    'packages/core/src/agent-global-message-queue.ts', 'packages/core/src/agent-message-journal.ts',
    'packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-client.ts',
    'packages/core/test/helpers/public-rpc-owner.ts', 'packages/core/test/helpers/object-cli-rpc.ts',
    'packages/core/scripts/verify-a2a-route-identity.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ url }) => ({ AGENTMUX_TEST_ROUTE_DIST: new URL('.', url('public-rpc-server.js')).href,
    AGENTMUX_TEST_RPC_CORE_ENTRY: url('index.js') }),
  callers: [
    { symbol: "case 'agent.send'", path: 'packages/core/src/public-rpc-service.ts' },
    { symbol: 'this.service.call', path: 'packages/core/src/public-rpc-wire.ts' },
    { symbol: 'new AgentMuxRpcDispatcher', path: 'packages/core/src/public-rpc-server.ts' },
    { symbol: "command('agent.send'", path: 'packages/core/src/agentmux-cli-commands.ts' },
    { symbol: 'connectAgentMuxRpc', path: 'packages/core/src/agentmux.ts' }
  ],
  mutations: [
    { label: 'route-not-durable-before-remote-effect', file: 'agent-global-message-queue.js',
      before: "await this.appendRecord({ kind: 'message-route', sequence: this.nextSequence, route: candidate });", after: 'void candidate;' },
    { label: 'mid-retry-replaced-by-operation-only-lookup', file: 'agent-global-message-queue.js',
      before: "const byMessage = messageId === undefined ? undefined : this.db.prepare(select + 'm.message_id=?').get(messageId);", after: 'const byMessage = undefined;' },
    { label: 'source-and-body-conflicts-not-rejected-at-ingress', file: 'agent-message-route.js',
      before: 'route.messageId !== input.messageId || route.intentDigest !== input.intentDigest', after: 'false' },
    { label: 'explicit-target-conflict-ignored', file: 'agent-message-route.js',
      before: 'if (!isDeepStrictEqual(route.target, input.target) &&', after: 'if (false && !isDeepStrictEqual(route.target, input.target) &&' },
    { label: 'semantic-owner-replaced-under-original-host-alias', file: 'public-rpc-service.js',
      before: 'route.runtimeId !== null && scopes[0].client.runtimeOwnerIdentity?.()?.runtimeId !== route.runtimeId', after: 'false' },
    { label: 'original-operation-query-forgets-retained-route', file: 'public-rpc-service.js',
      before: 'const route = await (await this.messageRouteJournal()).readMessageRoute(messageSelector.operationId, messageSelector.messageId);', after: 'const route = null;' },
    { label: 'concurrent-binding-overrides-explicit-run-fence', file: 'public-rpc-service.js',
      before: "if (expectedRun && expectedRun.runId !== route.expectedRun.runId)\n                throw new AgentMuxError('Expected Run conflicts with the first concurrent message route.', 'MESSAGE_RECIPIENT_MISMATCH');",
      after: 'void expectedRun;' },
    { label: 'local-shared-journal-first-send-creates-forwarding-loop', file: 'public-rpc-service.js',
      before: "if (recipientOwner.hostId === 'local') {", after: "if (original && recipientOwner.hostId === 'local') {" }
  ]
})
