import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/provider-contract-adjacent'), test: {
  include: ['packages/core/test/agent-provider-protocol.test.ts', 'packages/core/test/agent-interaction.test.ts',
    'packages/core/test/turn-end-second-spelling.guard.test.ts', 'packages/core/test/hook-receipt-turn-end-spelling.guard.test.ts',
    'packages/core/test/permission-request-second-spelling.guard.test.ts', 'packages/core/test/providers/{claude,copilot,cursor,droid,gemini,grok,hermes}.test.ts'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20000 } })
