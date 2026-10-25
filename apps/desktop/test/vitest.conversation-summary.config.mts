import { defineConfig, defaultExclude } from 'vitest/config'
import base from './vitest.conversation-unified-consumers.config.mts'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-summary', test: { ...base.test,
  include: ['apps/desktop/test/conversation-summary.test.tsx', 'packages/client-ui/test/conversation-process-detail.test.tsx'],
  exclude: [...defaultExclude], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 30000 } })
