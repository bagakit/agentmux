import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))

export default defineConfig({
  root,
  resolve: { alias: {
    '@agentmux/core': fileURLToPath(new URL('../../../../../packages/core/src/browser-page-capability.ts', import.meta.url))
  } },
  test: {
    environment: 'node',
    include: [
      'apps/desktop/test/browser-cdp-session.test.ts',
      'apps/desktop/test/browser-page-dispatch.test.ts',
      'apps/desktop/test/browser-script-runner.test.ts'
    ],
    maxWorkers: 1,
    fileParallelism: false
  }
})
