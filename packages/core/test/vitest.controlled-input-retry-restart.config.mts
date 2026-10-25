import { defineConfig } from 'vitest/config'
import base from './vitest.input-mailbox.config.mts'

export default defineConfig({ ...base, test: { ...base.test,
  include: ['packages/core/test/controlled-input-retry-restart.test.ts'], testTimeout: 60_000, hookTimeout: 30_000 } })
