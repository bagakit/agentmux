import { join } from 'node:path'
import { runA2aProof } from './lib/a2a-proof.mjs'

await runA2aProof({
  name: 'agent-messaging-guidance-proof',
  tests: ['packages/core/test/agent-messaging-guidance.test.ts'],
  sourceInputs: ['packages/core/src/agent-messaging-guidance.ts', 'packages/core/src/client.ts', 'packages/core/src/agentmux.ts',
    'packages/core/src/agentmux-cli-help.ts', 'packages/core/src/agent-outbound-message.ts',
    'packages/core/scripts/verify-agent-messaging-guidance.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ core, dist, url }) => ({ AGENTMUX_TEST_GUIDANCE_CLIENT: url('client.js'),
    AGENTMUX_TEST_GUIDANCE_CLI: join(dist, 'agentmux.js'), AGENTMUX_TEST_GUIDANCE_DAEMON: join(core, 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd') }),
  callers: [
    { symbol: 'messaging: AGENTMUX_AGENT_MESSAGING_RULES', path: 'packages/core/src/agentmux.ts' },
    { symbol: 'AGENTMUX_AGENT_MESSAGING_GUIDANCE', path: 'packages/core/src/agent-outbound-message.ts' },
    { symbol: 'AGENTMUX_AGENT_MESSAGING_GUIDANCE', path: 'packages/core/src/agentmux-cli-help.ts' },
    { symbol: 'composeAgentLaunchPrompt(originalPrompt, input.injectAgentMuxGuide', path: 'packages/core/src/client.ts' }
  ],
  mutations: [
    { label: 'actual-whoami-contract-removed', file: 'agentmux.js', before: 'messaging: AGENTMUX_AGENT_MESSAGING_RULES,', after: 'messaging: {},' },
    { label: 'actual-launch-guide-disconnected', file: 'client.js',
      before: 'composeAgentLaunchPrompt(originalPrompt, input.injectAgentMuxGuide, input.agentMuxNote)', after: 'composeAgentLaunchPrompt(originalPrompt, false, input.agentMuxNote)' },
    { label: 'actual-skill-contract-disconnected', file: 'agentmux-cli-help.js', before: '${AGENTMUX_AGENT_MESSAGING_GUIDANCE}', after: 'Runtime source automatically added.' }
  ]
})
