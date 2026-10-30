import base from './hook-postcommit-observation.vitest.config.mts'
import { resolve } from 'node:path'

export default { ...base, resolve: { alias: [
  { find: '@agentmux/identity/runtime-source', replacement: resolve(import.meta.dirname, '../../identity/dist/runtime-source.js') },
  ...base.resolve.alias
] }, test: { ...base.test, passWithNoTests: false, fileParallelism: false,
  include: ['packages/core/test/startup-recovery-lifecycle.test.ts', 'packages/core/test/frontend-continuity-supervision.test.ts',
    'packages/core/test/agent-session-recovery-sources.test.ts', 'packages/core/test/startup-recovery-reboot.integration.test.ts'],
  env: { AGENTMUX_TEST_OWNER_ENTRY: resolve(import.meta.dirname, 'fixtures/frontend-recovery-owner.mjs') },
  testTimeout: 90_000, hookTimeout: 30_000
} }
