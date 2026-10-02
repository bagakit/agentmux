import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
export default defineConfig({ ...base, test: { ...base.test,
  globalSetup: [], include: ['packages/core/test/agent-semantic-state-entry.test.ts',
    'packages/core/test/session-timeline.test.ts', 'packages/core/test/session-timeline-retention.test.ts',
    'packages/core/test/session-timeline-processing-cost.test.ts', 'packages/core/test/retired-session-history.test.ts',
    'packages/core/test/acp-adapter.test.ts', 'packages/core/test/client-connection-lost.test.ts'],
  passWithNoTests: false, maxWorkers: 1 } })
