import { defineConfig } from 'vitest/config'
import original from './vitest.config'

export default defineConfig({
  ...original,
  test: {
    ...original.test,
    include: ['apps/desktop/test/shared-agent-activity-links.test.tsx'],
    passWithNoTests: false,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000
  }
})
