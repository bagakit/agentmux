import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
export default defineConfig({ ...base, test: { ...base.test,
  include: ['apps/desktop/test/retired-session-history-ipc.test.ts', 'apps/desktop/test/runtime-session-history.test.ts'],
  passWithNoTests: false, maxWorkers: 1 } })
