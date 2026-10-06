import { join } from 'node:path'
import { runA2aProof } from './lib/a2a-proof.mjs'

await runA2aProof({
  name: 'agent-messaging-guidance-proof',
  tests: ['packages/core/test/agent-messaging-guidance.test.ts'],
  sourceInputs: ['packages/core/src/agent-messaging-guidance.ts', 'packages/core/src/client.ts', 'packages/core/src/agentmux.ts',
    'packages/core/src/control-host.ts', 'packages/core/src/public-rpc-service.ts',
    'packages/core/src/agentmux-cli-help.ts', 'packages/core/src/agent-outbound-message.ts',
    'packages/core/scripts/verify-agent-messaging-guidance.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ core, dist, url }) => ({ AGENTMUX_TEST_GUIDANCE_CLIENT: url('client.js'),
    AGENTMUX_TEST_GUIDANCE_SERVER: url('control-host.js'),
    AGENTMUX_TEST_GUIDANCE_CLI: join(dist, 'agentmux.js'), AGENTMUX_TEST_GUIDANCE_DAEMON: join(core, 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd') }),
  callers: [
    { symbol: 'messaging: AGENTMUX_AGENT_MESSAGING_RULES', path: 'packages/core/src/public-rpc-service.ts' },
    { symbol: 'AGENTMUX_AGENT_MESSAGING_GUIDANCE', path: 'packages/core/src/agent-outbound-message.ts' },
    { symbol: 'AGENTMUX_AGENT_MESSAGING_GUIDANCE', path: 'packages/core/src/agentmux-cli-help.ts' },
    { symbol: ': composeAgentLaunchPrompt(originalPrompt,', path: 'packages/core/src/client.ts' }
  ],
  mutations: [
    { label: 'actual-whoami-contract-removed', file: 'public-rpc-service.js', before: 'messaging: AGENTMUX_AGENT_MESSAGING_RULES,', after: 'messaging: {},' },
    { label: 'actual-launch-guide-disconnected', file: 'client.js',
      before: 'composeAgentLaunchPrompt(originalPrompt, forkSource ? true : input.injectAgentMuxGuide,', after: 'composeAgentLaunchPrompt(originalPrompt, false,' },
    { label: 'actual-skill-contract-disconnected', file: 'agentmux-cli-help.js', before: '${AGENTMUX_AGENT_MESSAGING_GUIDANCE}', after: 'Runtime source automatically added.' },
    { label: 'actual-launch-browser-preference-removed', file: 'agent-outbound-message.js',
      before: "prefer AgentMux's embedded Browser and public CLI", after: 'choose a Browser' },
    { label: 'actual-skill-browser-preference-removed', file: 'agentmux-cli-help.js',
      before: "prefer AgentMux's embedded Browser and public CLI", after: 'choose a Browser' },
    { label: 'actual-launch-browser-nearby-region-removed', file: 'agent-outbound-message.js',
      before: 'prefer a directional Region in that same Tab', after: 'choose any available Region' },
    { label: 'actual-skill-browser-nearby-region-removed', file: 'agentmux-cli-help.js',
      before: 'prefer a directional Region in that same Tab', after: 'choose any available Region' }
  ]
})
