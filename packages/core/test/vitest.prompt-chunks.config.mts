import { defineConfig } from 'vitest/config'
export default defineConfig({ test: {
  include: ['packages/core/test/prompt-submission-diagnostics.test.ts', 'packages/core/test/current-terminal-input.test.ts', 'packages/core/test/agent-execution-bridge.test.ts'],
  passWithNoTests: false, maxWorkers: 1, testTimeout: 15_000
} })
