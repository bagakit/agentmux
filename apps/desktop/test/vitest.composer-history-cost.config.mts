import { defineConfig } from 'vitest/config'
import base from './vitest.performance-reading.config.mts'
import owning from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'

export default defineConfig({
  ...base,
  resolve: owning.resolve!,
  ssr: owning.ssr!,
  cacheDir: '.cache/composer-history-cost',
  test: {
    ...base.test,
    environment: 'happy-dom',
    include: [
      'apps/desktop/test/composer-history-merge-cost.test.tsx',
      'apps/desktop/test/composer-history-live-seed.test.tsx'
    ],
    globalSetup: [],
    setupFiles: [],
    maxWorkers: 1,
    passWithNoTests: false
  }
})
