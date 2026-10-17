import { join, resolve } from 'node:path'
import { launchPrivateA2aProof } from './lib/a2a-private-model-proof.mjs'

const sourceInputs = ['packages/core/bin/amux', 'packages/core/bin/agentmux-hook.js', ...[
  'index', 'client', 'agent-capability', 'agent-global-message-queue', 'agent-message-journal', 'agent-message-query',
  'agent-message-notification', 'agent-message-notifications', 'ctxmux-run-adapter', 'agent-message-render', 'agent-outbound-message', 'agent-messaging-guidance',
  'agentmux', 'agentmux-cli-commands', 'agentmux-cli-help', 'agentmux-cli-module-skills', 'agent-skills', 'agent-self-context',
  'agent-session-identity', 'agent-session-registry', 'agent-session-store', 'prompt-submission', 'prompt-submission-record',
  'public-rpc', 'public-rpc-client', 'public-rpc-server', 'public-rpc-service', 'rpc-native-codec', 'runtime-paths',
  'providers/codex', 'providers/codex-native-input', 'providers/codex-native-rpc', 'providers/codex-managed-run',
  'providers/codex-managed-frontend', 'providers/codex-session-status', 'providers/codex-prompt-execution-evidence'
].map(name => `packages/core/src/${name}.ts`),
  'packages/core/scripts/verify-a2a-reference-agent-flow.mjs', 'packages/core/scripts/lib/a2a-private-model-proof.mjs',
  'packages/core/scripts/fixtures/a2a-reference-agent/coordinator.mjs',
  ...['peer', 'process', 'native-evidence'].map(name => `packages/core/scripts/fixtures/a2a-agent-behavior/${name}.mjs`)]

await launchPrivateA2aProof({
  repository: resolve(import.meta.dirname, '../../..'), sourceInputs,
  coordinatorEntry: join(import.meta.dirname, 'fixtures/a2a-reference-agent/coordinator.mjs'),
  freezeCandidate: true, name: 'a2a-reference-agent-flow', schema: 'agentmux.a2a-reference-agent-launcher.v1',
  scenario: 'idle-reference-native-discovery', model: process.env.AGENTMUX_A2A_REFERENCE_MODEL || 'gpt-6.1-sol',
  prepareOnly: process.argv.includes('--prepare-only'), privatePrefix: 'amr-', requiredFlags: ['--no-daemon', 'app-server', '--remote']
})
