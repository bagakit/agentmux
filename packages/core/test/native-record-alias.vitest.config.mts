import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
// These consumers import Core Source; only the Darwin process-identity helper
// is compiled. No compiled Core/CLI/Renderer result is signed by this suite.
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/native-record-alias-vite'), test: {
  include: ['packages/core/test/native-record-alias.integration.test.ts'],
  setupFiles: [resolve(root, 'vitest.setup.ts')],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000, hookTimeout: 15_000
} })
