import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  root,
  cacheDir: resolve(root, '.local/cache/captured-history-durability-vite'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: {
    include: ['packages/core/test/captured-history-durability.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false,
    testTimeout: 30000, hookTimeout: 30000
  }
})
