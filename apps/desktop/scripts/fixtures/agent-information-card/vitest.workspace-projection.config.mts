import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import shared from '../focus-card-identity/vitest.owning.config.mts'

/** The real Workspace consumer and its original Core/Store projection owners. */
export default defineConfig({ ...shared,
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/agent-information-card/workspace-projection-cache'),
  test: { ...shared.test, include: ['apps/desktop/test/workspace-agent-projection.test.tsx'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
