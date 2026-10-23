import base from './hook-postcommit-observation.vitest.config.mts'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { staleDistComplaint } from '../../../vitest.dist-freshness.js'

// Existing cross-process/CLI owners consume the actual compiled package.
// Refuse stale artifacts before admitting those proofs; the three managed
// initialization cases continue to load and hash their production source.
const complaint = await staleDistComplaint(resolve(import.meta.dirname, '..'))
if (complaint) throw new Error(complaint)
const compiledOwner = pathToFileURL(resolve(import.meta.dirname, 'fixtures/agent-session-recovery/compiled-owner.mjs')).href

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
  reporters: ['default', 'json'],
  outputFile: { json: resolve(import.meta.dirname, '../../../.local/state/agent-session-recovery/qualification.json') },
  environment: 'node', env: {
    AGENTMUX_TEST_CONTINUITY_SUPERVISION_ENTRY: compiledOwner,
    AGENTMUX_TEST_INITIAL_CONTINUITY_ENTRY: compiledOwner,
    AGENTMUX_TEST_OBJECT_CLI: resolve(import.meta.dirname, '../bin/amux')
  }, fileParallelism: false, maxWorkers: 1, passWithNoTests: false,
  testTimeout: 60_000, hookTimeout: 40_000
} }
