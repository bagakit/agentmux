import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/core/test/agent-input-context-capture.test.ts'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 10000 } })
