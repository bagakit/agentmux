import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
export default defineConfig({ ...base, test: { ...base.test,
  include: ['packages/core/test/retired-session-history.test.ts', 'packages/core/test/session-history.test.ts',
    'packages/core/test/agent-session-store.test.ts', 'packages/core/test/agent-session-registry.test.ts'],
  passWithNoTests: false, maxWorkers: 1 } })
