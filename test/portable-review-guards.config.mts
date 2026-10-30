import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// These Node-only developer tools consume source directly; no product dist is involved.
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    include: [
      'test/tracker-gate-names-existing-tests.test.ts',
      'apps/desktop/test/commit-message-anchor-provenance.test.ts',
      'apps/desktop/test/commit-fix-guard-coupling.test.ts'
    ],
    setupFiles: [resolve(import.meta.dirname, '../vitest.setup.ts')],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1
  }
})
