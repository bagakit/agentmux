import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.local/provider-native-child-protocol/cache'), test: {
  include: ['packages/core/test/claude-native-child-protocol.test.ts', 'packages/core/test/claude-native-request-lifecycle.test.ts'],
  setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1,
  fileParallelism: false, testTimeout: 20000, hookTimeout: 15000
} })
