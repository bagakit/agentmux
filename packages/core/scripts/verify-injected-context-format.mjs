import { runA2aProof } from './lib/a2a-proof.mjs'

await runA2aProof({
  name: 'injected-context-format-proof',
  tests: ['packages/core/test/agent-injected-context-format.test.ts'],
  sourceInputs: ['packages/core/src/agent-outbound-message.ts', 'packages/core/src/agent-message-render.ts',
    'packages/core/src/agent-messaging-guidance.ts', 'packages/core/scripts/verify-injected-context-format.mjs',
    'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ url }) => ({ AGENTMUX_TEST_INJECTED_CONTEXT_OUTBOUND: url('agent-outbound-message.js'),
    AGENTMUX_TEST_INJECTED_CONTEXT_READER: url('agent-message-render.js') }),
  callers: [
    { symbol: 'composeAgentLaunchPrompt(originalPrompt, input.injectAgentMuxGuide', path: 'packages/core/src/client.ts' },
    { symbol: 'parseAgentMuxMessagePrefix(parts[0].text)', path: 'packages/client-ui/src/components/ConversationMessage.tsx' }
  ],
  mutations: [
    { label: 'platform-text-inserted-as-xml', file: 'agent-outbound-message.js',
      before: "return new XMLSerializer().serializeToString(envelope).replace(/\\r/g, '&#13;');",
      after: 'return `<amux from="${AMUX_FROM}">\\n${text}\\n</amux>`;' },
    { label: 'original-user-body-trimmed', file: 'agent-outbound-message.js',
      before: 'const userRequest = prompt?.trim() ? prompt : undefined;',
      after: 'const userRequest = prompt?.trim() ? prompt.trim() : undefined;' }
  ]
})
