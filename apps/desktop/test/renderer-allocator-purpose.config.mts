import { defineConfig } from 'vitest/config'
import owning from './renderer-v8-profile.config.mts'
export default defineConfig({ ...owning,
  resolve: { ...owning.resolve, conditions: ['node', 'import', 'default'] },
  ssr: { ...owning.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  test: { ...owning.test,
  include: ['apps/desktop/test/renderer-trace.test.ts'],
  testNamePattern: process.env.ALLOCATOR_TEST_PATTERN ?? '^(allocator purpose |preserves original gzip and raw JSON for 1000|refuses a pre-existing|rejects a changed source|does not convert data loss|rejects invalid gzip|rejects a native chunk|retains an IO.close failure)',
  testTimeout: 30000
} })
