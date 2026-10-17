import { join, resolve } from 'node:path'
import { launchPrivateA2aProof } from './lib/a2a-private-model-proof.mjs'

const sourceInputs = ['packages/core/bin/amux', 'packages/core/src/index.ts', 'packages/core/src/public-rpc-http.ts', 'packages/core/src/agent-messaging-guidance.ts', 'packages/core/src/agent-outbound-message.ts',
  'packages/core/src/agent-message-render.ts', 'packages/core/src/client.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux.ts', 'packages/core/src/agent-skills.ts', 'packages/core/src/agentmux-cli-help.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/src/rpc-business-codec.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agent-self-context.ts',
  'packages/core/src/agent-global-message-queue.ts', 'packages/core/src/prompt-submission.ts', 'packages/core/src/runtime-paths.ts', 'packages/core/src/agentmux-cli-module-skills.ts',
  'packages/core/src/agentmux-cli-shared-guides.ts', 'packages/core/src/agentmux-cli-browser-guide.ts', 'packages/core/src/agentmux-cli-resource-guide.ts',
  'packages/core/src/agentmux-cli-note-guide.ts', 'packages/core/src/goal-role-guidance.ts', 'packages/core/src/browser-page-capability.ts',
  'packages/core/scripts/verify-a2a-agent-behavior.mjs', 'packages/core/scripts/lib/a2a-private-model-proof.mjs', ...['coordinator', 'codex-exec', 'peer', 'process', 'scenarios', 'native-evidence'].map(name => 'packages/core/scripts/fixtures/a2a-agent-behavior/' + name + '.mjs')]

await launchPrivateA2aProof({
  repository: resolve(import.meta.dirname, '../../..'), sourceInputs,
  coordinatorEntry: join(import.meta.dirname, 'fixtures/a2a-agent-behavior/coordinator.mjs'),
  model: process.env.AGENTMUX_A2A_BEHAVIOR_MODEL || 'gpt-6.1-sol',
  minimumOnly: process.argv.includes('--minimum-only'), prepareOnly: process.argv.includes('--prepare-only')
})
