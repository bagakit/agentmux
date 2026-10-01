import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))

export default defineConfig({
  root,
  resolve: { alias: [
    { find: /^@agentmux\/core$/, replacement: fileURLToPath(new URL('../../../../../packages/core/src/index.ts', import.meta.url)) },
    { find: '@agentmux/core/control', replacement: fileURLToPath(new URL('../../../../../packages/core/src/control.ts', import.meta.url)) }
  ] },
  test: {
    environment: 'node',
    include: [
      'apps/desktop/test/browser-cdp-session.test.ts',
      'apps/desktop/test/browser-page-dispatch.test.ts',
      'apps/desktop/test/browser-script-runner.test.ts',
      'apps/desktop/test/browser-external-target.test.ts'
    ],
    maxWorkers: 1,
    fileParallelism: false
  }
})
