import assert from 'node:assert/strict'
import { runA2aProof } from '../../../packages/core/scripts/lib/a2a-proof.mjs'

const trackerScript = process.env.AGENTMUX_TEST_FEATURE_TRACKER_SCRIPT
assert.ok(trackerScript?.endsWith('/feature-tracker.sh'), 'Select the public feature-tracker.sh explicitly for the private task-source fixtures.')
const tests = ['apps/desktop/test/continuous-progress-unified-ingress.test.ts', 'apps/desktop/test/continuous-progress-delivery.test.ts']

await runA2aProof({
  name: 'injected-context-progress-proof', tests,
  regressionTests: ['apps/desktop/test/continuous-progress-loop-manager.test.ts',
    'apps/desktop/test/continuous-progress-loop-store.test.ts', 'packages/core/test/continuous-progress-scheduler.test.ts'],
  sourceInputs: ['packages/core/src/index.ts', 'packages/core/src/continuous-progress-scheduler.ts',
    'packages/core/src/agent-messaging-guidance.ts', 'packages/core/src/agent-outbound-message.ts',
    'packages/core/src/client.ts', 'packages/core/src/prompt-submission.ts', 'packages/core/src/types.ts',
    'apps/desktop/src/main/continuous-progress-loop-manager.ts', 'apps/desktop/src/main/continuous-progress-delivery.ts',
    'apps/desktop/src/main/continuous-progress-loop-store.ts', 'apps/desktop/src/main/runtime-controller.ts',
    'apps/desktop/test/helpers/continuous-progress-tracker.ts',
    'apps/desktop/scripts/verify-injected-context-progress.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ url }) => ({ AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT: url('client.js'),
    AGENTMUX_TEST_FEATURE_TRACKER_SCRIPT: trackerScript }),
  callers: [
    { symbol: 'deliverContinuousProgress(runtime, loop', path: 'apps/desktop/src/main/index.ts' },
    { symbol: 'this.onTick(', path: 'apps/desktop/src/main/continuous-progress-loop-manager.ts' },
    { symbol: 'runtime.submitPrompt(', path: 'apps/desktop/src/main/continuous-progress-delivery.ts' },
    { symbol: 'client.submitAgentPrompt({', path: 'apps/desktop/src/main/runtime-controller.ts' },
    { symbol: 'AGENTMUX_AGENT_MESSAGING_GUIDANCE', path: 'apps/desktop/src/main/continuous-progress-loop-manager.ts' }
  ],
  mutations: [
    { label: 'progress-shared-context-disconnected', file: '../../apps/desktop/src/main/continuous-progress-delivery.ts',
      projectTests: tests, before: 'undefined, undefined, pending.agentMuxNote)', after: 'undefined, undefined, undefined)' },
    { label: 'progress-retry-uses-current-body', file: '../../apps/desktop/src/main/continuous-progress-delivery.ts',
      projectTests: tests, before: 'condition.expectedRun }, pending.prompt, operationId, condition,',
      after: 'condition.expectedRun }, loop.prompt, operationId, condition,' },
    { label: 'progress-user-body-trimmed', file: '../../apps/desktop/src/main/continuous-progress-loop-manager.ts',
      projectTests: tests, before: 'prompt: claim.loop.prompt, agentMuxNote: AGENTMUX_AGENT_MESSAGING_GUIDANCE',
      after: 'prompt: claim.loop.prompt.trim(), agentMuxNote: AGENTMUX_AGENT_MESSAGING_GUIDANCE' },
    { label: 'progress-input-fence-bypassed', file: 'prompt-submission.js',
      before: 'if (run.acceptedInputBytes !== expectedInputByte)', after: 'if (false)' }
  ]
})
