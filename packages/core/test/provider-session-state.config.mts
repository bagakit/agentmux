import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.local/provider-session-state/cache'), test: {
  include: ['packages/core/test/provider-session-state.test.ts', 'packages/core/test/provider-observation-contract.test.ts',
    'packages/core/test/stop-background-tasks-idle.test.ts', 'packages/core/test/claude-native-current-activity.test.ts'],
  setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1,
  fileParallelism: false, testTimeout: 20000, hookTimeout: 15000
} })
