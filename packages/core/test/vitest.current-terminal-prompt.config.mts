import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({ cacheDir: resolve(import.meta.dirname, '../../../.local/cache/current-terminal-prompt-vite'),
  test: { include: ['packages/core/test/current-terminal-prompt.test.ts'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 10000 } })
