import { defineConfig } from 'vitest/config'

// The real inspector child consumes its fixture App's actual compiled SDK.
// The gate records those exact loaded bytes; unrelated workspace dist freshness
// is not a prerequisite for testing this process wrapper.
export default defineConfig({
  test: { include: ['apps/desktop/test/package-ui-observation-rpc.test.ts'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false,
    testNamePattern: process.env.AGENTMUX_UI_BUDGET_TEST_PATTERN,
    testTimeout: 25_000, hookTimeout: 10_000 }
})
