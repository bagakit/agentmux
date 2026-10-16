import { join } from 'node:path'
import { runA2aProof } from './lib/a2a-proof.mjs'

await runA2aProof({
  name: 'a2a-message-query',
  tests: ['packages/core/test/a2a-message-query.test.ts'],
  environment: ({ dist, url }) => ({
    AGENTMUX_TEST_QUERY_CORE: url('index.js'),
    AGENTMUX_TEST_QUERY_SERVER: url('public-rpc-server.js'),
    AGENTMUX_TEST_QUERY_RPC: url('public-rpc-client.js'),
    AGENTMUX_TEST_QUERY_HOSTED_SERVICE: url('hosted-runtime-service.js'),
    AGENTMUX_TEST_QUERY_HOSTED_CLIENT: url('hosted-client.js'),
    AGENTMUX_TEST_OBJECT_CLI: join(dist, 'agentmux.js')
  }),
  sourceInputs: [
    'packages/core/src/index.ts', 'packages/core/src/agent-message-query.ts', 'packages/core/src/agent-global-message-queue.ts',
    'packages/core/src/agent-message-journal.ts', 'packages/core/src/client.ts',
    'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts',
    'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agentmux-cli-commands.ts',
    'packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-runtime-service.ts',
    'packages/core/src/agentmux-cli-module-skills.ts', 'packages/core/scripts/verify-a2a-message-query.mjs',
    'packages/core/scripts/lib/a2a-proof.mjs', 'packages/core/test/helpers/public-rpc-owner.ts',
    'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/fixture-values.ts'
  ],
  callers: [
    { path: 'packages/core/src/agentmux-cli-commands.ts', symbol: "command('message.ls'" },
    { path: 'packages/core/src/agentmux-cli-commands.ts', symbol: "command('message.read'" },
    { path: 'packages/core/src/agentmux.ts', symbol: 'client.call(method, invocation.params' },
    { path: 'packages/core/src/public-rpc-service.ts', symbol: 'owner.client.listMessages' },
    { path: 'packages/core/src/public-rpc-service.ts', symbol: 'owner.client.readMessage' },
    { path: 'packages/core/src/client.ts', symbol: 'this.messageQueue.listMessages' }
  ],
  mutations: [
    { label: 'participant-authority', file: 'client.js',
      before: "if (caller && caller.agentSessionId !== input.participantSessionId)\n            throw new AgentMuxError('An Agent can only browse its own original messages.'",
      after: "if (false && caller && caller.agentSessionId !== input.participantSessionId)\n            throw new AgentMuxError('An Agent can only browse its own original messages.'" },
    { label: 'locked-query-reauthorization', file: 'client.js',
      before: "return this.messageQueue.listMessages(input, async () => {\n            if (caller)",
      after: "return this.messageQueue.listMessages(input, async () => {\n            if (false && caller)" },
    { label: 'locked-msg-id-reauthorization', file: 'agent-global-message-queue.js',
      before: "const message = this.message(nonEmpty(messageId, 'Message id')) ?? null;\n            await reauthorize?.(message);",
      after: "const message = this.message(nonEmpty(messageId, 'Message id')) ?? null;\n            // mutant: skip original participant reauthorization" },
    { label: 'metadata-only-js-boundary', file: 'agent-global-message-queue.js',
      before: "json_remove(original.json, '$.envelope.body') AS metadata",
      after: 'original.json AS metadata' },
    { label: 'participant-direction-index', file: 'agent-global-message-queue.js',
      before: "const side = input.direction === 'incoming' ? 'recipient' : 'sender';",
      after: "const side = input.direction === 'incoming' ? 'sender' : 'recipient';" },
    { label: 'immutable-page-order', file: 'agent-global-message-queue.js',
      before: 'AND original.sequence < ? ORDER BY original.sequence DESC LIMIT ?',
      after: 'AND original.sequence < ? ORDER BY original.sequence ASC LIMIT ?' },
    { label: 'cli-stable-message-id', file: 'agentmux-cli-commands.js',
      before: "[selected === '--message-id' ? 'messageId' : 'operationId']",
      after: "[selected === '--message-id' ? 'operationId' : 'operationId']" },
    { label: 'rpc-query-product-wiring', file: 'public-rpc-service.js',
      before: 'result = { ...await owner.client.listMessages({',
      after: 'result = { ...await owner.client.listDispatches({' },
    { label: 'strict-page-participant-codec', file: 'rpc-native-codec.js',
      before: "if (input.hostId !== undefined && p.hostId !== input.hostId || p.direction !== input.direction ||\n                    p.participantSessionId !== (input.participantSessionId ?? credentials?.agentSessionId) ||\n                    credentials && p.participantSessionId !== credentials.agentSessionId)",
      after: "if (input.hostId !== undefined && p.hostId !== input.hostId || p.direction !== input.direction)" }
  ]
})
