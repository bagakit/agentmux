import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root,
  cacheDir: resolve(root, '.tmp/recovery-protocol-convergence/provider-runtime-cache'),
  test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/resumed-turn-runtime.integration.test.ts'], testTimeout: 120_000 }
})
