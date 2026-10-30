import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', globalSetup: [], passWithNoTests: false,
  fileParallelism: false, maxWorkers: 1, include: ['packages/core/test/native-startup-join.test.ts'], testTimeout: 15_000, hookTimeout: 10_000 } })
