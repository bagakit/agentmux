import { defineConfig } from 'vitest/config'
import shared from '../workbench-identity/vitest.owning.config.mts'
export default defineConfig({ ...shared, cacheDir: '.tmp/focus-reading-density/lanes-cache', test: { ...shared.test,
  include: ['apps/desktop/test/focus-lane-density.test.tsx', 'apps/desktop/test/workbench-tab-naming.test.tsx'],
  maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
