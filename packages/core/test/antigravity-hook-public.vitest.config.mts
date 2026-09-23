import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../vitest.config.ts'

export default mergeConfig(base, defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    include: ['packages/core/test/providers/antigravity-hook-public.test.ts'],
    passWithNoTests: false,
    fileParallelism: false
  }
}))
