import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
export default defineConfig({ ...base, test: { ...base.test,
  globalSetup: [], include: ['packages/core/test/session-work-history.test.ts'],
  passWithNoTests: false, maxWorkers: 1 } })
