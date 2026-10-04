import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ root, test: { include: [
  'packages/core/test/agent-session-store.test.ts', 'packages/core/test/agent-session-registry.test.ts',
  'packages/core/test/client-submit-prompt-run-binding.test.ts', 'packages/core/test/agent-semantic-state-entry.test.ts'
], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15000 } })
