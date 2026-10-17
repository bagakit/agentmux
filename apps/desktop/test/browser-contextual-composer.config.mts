import base from '../scripts/fixtures/browser-use-settings/vitest.config.mts'
export default { ...base, test: { ...base.test, include: [
  'apps/desktop/test/browser-contextual-composer.test.tsx',
  'apps/desktop/test/browser-contextual-activity.test.tsx',
  'apps/desktop/test/browser-contextual-queue.test.ts',
  'apps/desktop/test/browser-trace-reading-host.test.tsx'
], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } }
