import { runA2aProof } from '../../../packages/core/scripts/lib/a2a-proof.mjs'

const tests = ['apps/desktop/test/injected-context-goals-browser.test.tsx']
await runA2aProof({
  name: 'injected-context-goals-proof', tests,
  regressionTests: ['apps/desktop/test/browser-annotations.test.ts', 'apps/desktop/test/agent-sharing-metadata.test.ts'],
  sourceInputs: ['apps/desktop/src/renderer/src/lib/goals-entry-actions.ts', 'apps/desktop/src/renderer/src/lib/goal-project-context.ts',
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/browser-annotations.ts',
    'apps/desktop/src/renderer/src/components/BrowserToolsPanel.tsx', 'apps/desktop/src/renderer/src/components/BrowserAnnotationsPanel.tsx',
    'apps/desktop/src/preload/index.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/runtime-controller.ts',
    'packages/core/src/sharing.ts', 'packages/core/src/agent-outbound-message.ts', 'packages/core/src/client.ts',
    'packages/core/src/prompt-submission.ts', 'packages/core/src/types.ts',
    'apps/desktop/test/helpers/first-execution-ipc-bridge.ts', 'apps/desktop/test/helpers/injected-context-core.ts',
    'apps/desktop/scripts/verify-injected-context-goals.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: () => ({}),
  callers: [
    { symbol: 'startGoalExploration(action.body', path: 'apps/desktop/src/renderer/src/components/GoalsCommonActions.tsx' },
    { symbol: 'appendAgentComposerDraft(sessionId, formatBrowserAnnotationsContext', path: 'apps/desktop/src/renderer/src/components/BrowserToolsPanel.tsx' },
    { symbol: 'api.sessions.submitPrompt(', path: 'apps/desktop/src/renderer/src/store.ts' },
    { symbol: 'client.submitAgentPrompt({', path: 'apps/desktop/src/main/runtime-controller.ts' }
  ],
  mutations: [
    { label: 'goals-project-context-disconnected', file: '../../apps/desktop/src/renderer/src/lib/goals-entry-actions.ts', projectTests: tests,
      before: 'const agentMuxNote = project ? goalProjectContextText(project) : undefined', after: 'const agentMuxNote = undefined' },
    { label: 'browser-edited-draft-promoted-to-platform', file: '../../apps/desktop/src/renderer/src/store.ts', projectTests: tests,
      before: "pending.origin === 'manual', pending.agentMuxNote)", after: "pending.origin === 'manual', pending.agentMuxNote ?? pending.text)" }
  ]
})
