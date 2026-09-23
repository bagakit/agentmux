import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../vitest.config.ts'

export default mergeConfig(base, defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    include: [
      'packages/core/test/native-hook-subject-turn-boundary.test.ts',
      'packages/core/test/hook-payload-semantics.test.ts',
      'packages/core/test/hook-event-name-source.integration.test.ts'
    ],
    testTimeout: 15_000,
    passWithNoTests: false,
    fileParallelism: false
  }
}))
