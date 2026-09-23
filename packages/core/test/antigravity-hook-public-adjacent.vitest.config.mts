import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../vitest.config.ts'

export default mergeConfig(base, defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    include: [
      'packages/core/test/providers/antigravity-hook-public.test.ts',
      'packages/core/test/providers/antigravity-session-analysis.test.ts',
      'packages/core/test/providers/droid.test.ts',
      'packages/core/test/providers/droid-session-analysis.test.ts',
      'packages/core/test/hook-trusted-normalization-context.test.ts',
      'packages/core/test/hook-payload-semantics.test.ts',
      'packages/core/test/agent-provider.test.ts'
    ],
    passWithNoTests: false,
    fileParallelism: false
  }
}))
