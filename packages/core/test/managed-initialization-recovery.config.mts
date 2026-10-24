import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({ root: resolve(import.meta.dirname, '../../..'), test: {
  environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  include: ['packages/core/test/managed-initialization-public.integration.test.ts',
    'packages/core/test/frontend-startup-recovery.integration.test.ts'],
  env: { AGENTMUX_TEST_OWNER_ENTRY: resolve(import.meta.dirname, 'fixtures/frontend-recovery-owner.mjs') },
  testTimeout: 90_000, hookTimeout: 30_000
} })
