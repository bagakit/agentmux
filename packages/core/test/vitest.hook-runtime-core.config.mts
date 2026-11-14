import base from './vitest.hook-environment.config.mts'
import { defineConfig } from 'vitest/config'

export default defineConfig({ ...base, test: { ...base.test,
  include: ['packages/core/test/launch-scoped-hook-environment.test.ts'],
  testTimeout: 120_000, hookTimeout: 30_000
} })
