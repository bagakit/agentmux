import base from './hook-postcommit-observation.vitest.config.mts'
import { resolve } from 'node:path'

export default { ...base, resolve: { alias: [
  { find: '@agentmux/identity/runtime-source', replacement: resolve(import.meta.dirname, '../../identity/dist/runtime-source.js') },
  ...base.resolve.alias
] }, test: { ...base.test,
  include: [
    'packages/core/test/agent-session-recovery.integration.test.ts',
    'packages/core/test/agent-session-initialization-service.test.ts',
    'packages/core/test/session-continuity-supervision.test.ts',
    'packages/core/test/frontend-continuity-supervision.test.ts',
    'packages/core/test/session-continuity-control.test.ts',
    'packages/core/test/initial-continuity-cancellation.test.ts',
    'packages/core/test/session-continuity-launch-input.test.ts'
  ],
  environment: 'node', fileParallelism: false, maxWorkers: 1, passWithNoTests: false,
  testTimeout: 60_000, hookTimeout: 40_000
} }
