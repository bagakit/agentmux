import { defineConfig, defaultExclude } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'
export default defineConfig({ ...owning, cacheDir: '.cache/process-detail-density', test: { ...owning.test,
  include: ['apps/desktop/test/process-detail-density.test.tsx', 'apps/desktop/test/conversation-summary.test.tsx'],
  exclude: [...defaultExclude], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 30000 } })
