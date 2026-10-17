import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['apps/desktop/test/browser-input-selection-ipc.test.ts'],
  environment: 'node', passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
