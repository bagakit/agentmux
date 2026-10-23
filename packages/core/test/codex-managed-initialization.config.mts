import { defineConfig } from 'vitest/config'

// Source-only Provider qualification while the recovery service is integrated.
// No dist freshness bypass is used to qualify a compiled Core artifact.
export default defineConfig({ test: {
  include: ['packages/core/test/codex-managed-initialization.test.ts', 'packages/core/test/native-managed-launch.test.ts',
    'packages/core/test/codex-managed-run-diagnostics.test.ts'],
  fileParallelism: false, maxWorkers: 1, testTimeout: 15_000, hookTimeout: 15_000
} })
