import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    include: ['packages/core/test/interaction-input-target.test.ts', 'packages/core/test/client-interaction-lifecycle.test.ts', 'packages/core/test/interaction-input-provider.test.ts'],
    exclude: [], maxWorkers: 1
  }
})
