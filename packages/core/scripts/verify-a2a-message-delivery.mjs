import { runA2aProof } from './lib/a2a-proof.mjs'

const delivery = ['packages/core/test/client-agent-message-delivery.test.ts']
const codec = ['packages/core/test/agent-message-render.test.ts']
const upgrade = ['packages/core/test/original-input-wire-upgrade.test.ts']

// Wire cutover and original Input reconciliation share the actual public send
// consumer. Conversation presentation and product restart own separate gates.
await runA2aProof({
  name: 'a2a-message-delivery-proof',
  tests: [...delivery, ...codec, ...upgrade, 'packages/core/test/agent-message-leading-context.test.ts',
    'packages/core/test/agent-outbound-message.test.ts', 'packages/core/test/agent-send-cli-attribution.test.ts'],
  sourceInputs: ['packages/core/src/client.ts', 'packages/core/src/agent-capability.ts',
    'packages/core/src/agent-global-message-queue.ts', 'packages/core/src/agent-message-render.ts',
    'packages/core/src/agent-outbound-message.ts', 'packages/core/src/agent-messaging-guidance.ts',
    'packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-service.ts',
    'packages/core/test/helpers/previous-core-wire.ts', 'packages/core/test/helpers/public-rpc-owner.ts',
    'packages/core/test/helpers/object-cli-rpc.ts',
    'packages/core/scripts/verify-a2a-message-delivery.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ url }) => ({ AGENTMUX_TEST_A2A_CLIENT: url('client.js'), AGENTMUX_TEST_A2A_RENDER: url('agent-message-render.js') }),
  callers: [
    { symbol: 'submitAgentMessage', path: 'packages/core/src/public-rpc-service.ts' },
    { symbol: 'startDiscussion', path: 'packages/core/src/public-rpc-service.ts' },
    { symbol: 'client.call(method, invocation.params', path: 'packages/core/src/agentmux.ts' },
    { symbol: 'initialMessage', path: 'apps/desktop/src/renderer/src/lib/space-agent-control.ts' }
  ],
  mutations: [
    { label: 'sender-capability-disconnected', file: 'agent-capability.js', tests: delivery,
      before: 'if (!sameHash(hashAgentCapability(raw), binding.capabilityHash))', after: 'if (false)' },
    { label: 'actual-send-source-disconnected', file: 'client.js', tests: delivery,
      before: 'operationId: envelope.messageId, prompt: renderAgentMuxMessageEnvelope(envelope),',
      after: 'operationId: envelope.messageId, prompt: envelope.body,' },
    { label: 'actual-initial-source-disconnected', file: 'client.js', tests: delivery,
      before: 'const originalPrompt = initialEnvelope ? renderAgentMuxMessageEnvelope(initialEnvelope) : input.prompt;',
      after: 'const originalPrompt = input.prompt;' },
    { label: 'authored-body-trimmed', file: 'agent-message-render.js', tests: codec,
      before: '${envelope.body}\\n<reminder>', after: '${envelope.body.trim()}\\n<reminder>' },
    { label: 'authored-example-mistaken-for-reminder', file: 'agent-message-render.js', tests: codec,
      before: "text.lastIndexOf('\\n<reminder>')", after: "text.indexOf('\\n<reminder>')" },
    { label: 'original-wire-recomposed', file: 'client.js', tests: upgrade,
      before: 'const retainWire = frozen &&', after: 'const retainWire = false &&' },
    { label: 'current-authority-replaced-by-cache', file: 'client.js', tests: delivery,
      before: 'await this.registry.refresh(sender.agentSessionId, sender.run);', after: '/* stale registry */' },
    { label: 'durable-intent-before-input-disconnected', file: 'client.js', tests: delivery,
      before: `const queued = await this.messageQueue.append({ ...envelope,
            sourceChannel, ...(sourceDevice ? { sourceDevice } : {}),
            ...(admissionIntent.kind !== 'exact-condition' ? { admissionIntent } : {}),
            ...(input.execution === undefined ? {} : { execution: input.execution }) }, admissionIntent.kind !== 'exact-condition' && !originalAdmission ? { inputEnvironment: this.inputSavedEnvironment(recipient),
            originalClaimAbsent: async () => !await this.inspectAgentPromptSubmission(key) } : undefined);`,
      after: "const queued = { envelope, delivery: { state: 'queued' } };" }
  ]
})
