import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    environment: 'node', passWithNoTests: false, maxWorkers: 2,
    include: ['agent-execution-bridge', 'agent-execution-bridge-native', 'agent-execution-coordinator',
      'agent-execution-executor', 'public-rpc-execution-bindings', 'codex-execution-helper']
      .map(name => `packages/core/test/${name}.test.ts`),
    testTimeout: 30_000, hookTimeout: 30_000,
  },
})
