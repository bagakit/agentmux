import config from './vitest.owning.config.mts'

export default {
  ...config,
  test: { ...config.test, include: ['apps/desktop/test/browser-app-link-handoff.test.ts', 'apps/desktop/test/browser-local-recovery-manager.test.ts', 'apps/desktop/test/browser-outcome-manager.test.ts', 'apps/desktop/test/browser-page-action-feedback.test.ts', 'apps/desktop/test/browser-presentation-resource.test.ts', 'apps/desktop/test/browser-ref-ledger.test.ts', 'apps/desktop/test/browser-run-script-wiring.test.ts', 'apps/desktop/test/browser-task-outcome-download-manager.test.ts', 'apps/desktop/test/browser-view-manager.test.ts'] }
}
