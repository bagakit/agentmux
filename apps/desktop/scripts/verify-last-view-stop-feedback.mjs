import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const source = 'apps/desktop/src/renderer/src/'
await verifyRendererSourceMutations({
  name: 'last-view-stop-feedback',
  owningConfig: 'apps/desktop/test/vitest.last-view-stop-feedback.config.mts',
  tests: ['apps/desktop/test/agent-last-view-split-close.test.tsx',
    'apps/desktop/test/agent-last-view-close.test.ts', 'apps/desktop/test/workbench-view-close.test.ts'],
  sources: ['vitest.config.ts', 'vitest.dist-freshness.ts', 'test/fixture-values.mjs',
    'apps/desktop/test/vitest.mote-context.config.mts', 'apps/desktop/test/helpers/session-stop-receipt.ts',
    ...['components/WorkspaceWorkbench.tsx', 'components/SessionPane.tsx', 'components/AgentRegionHeader.tsx',
      'components/FocusContextRow.tsx', 'components/AgentOperationFeedback.tsx', 'components/ConfirmationDialog.tsx',
      'store.ts', 'lib/session-stop-intent.ts', 'lib/agent-operation-feedback.ts', 'lib/agent-operation.ts',
      'lib/last-view-close-confirmation.ts', 'lib/workbench-view-close.ts'].map(file => source + file)],
  mutations: [
    { label: 'tab-modal-waits-for-stop', file: source + 'components/WorkspaceWorkbench.tsx',
      before: '    if (!keepAgentSessions && lastViewCloseStops(original.confirmation)) setPendingClose(null)',
      after: '    // Revert the Tab caller to waiting for Stop before dismissing its modal.' },
    { label: 'region-modal-waits-for-stop', file: source + 'components/WorkspaceWorkbench.tsx',
      before: '    if (!keepAgentSessions && lastViewCloseStops(original)) setConfirmingClose(null)',
      after: '    // Revert the Region caller to waiting for Stop before dismissing its modal.' }
  ]
})
