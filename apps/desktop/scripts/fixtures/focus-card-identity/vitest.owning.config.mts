import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import shared from '../workbench-identity/vitest.owning.config.mts'

/** The same browser/source bindings as the identity owner, with one explicit consumer set. */
export default defineConfig({ ...shared,
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-card-identity/vitest-cache'),
  test: { ...shared.test, include: ['apps/desktop/test/focus-workbench-identity.test.tsx'] }
})
