import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: { include: ['packages/core/test/initial-transport-preparation.test.ts', 'packages/core/test/initial-transport-provider.test.ts'],
    exclude: [], maxWorkers: 1, testTimeout: 10_000 }
})
