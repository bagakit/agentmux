import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({ root: resolve(import.meta.dirname, '../../..'), test: {
  include: ['apps/desktop/test/amux-object-link-process-restore.test.ts'], passWithNoTests: false,
  globalSetup: [], maxWorkers: 1, fileParallelism: false, testTimeout: 45000, hookTimeout: 60000
} })
