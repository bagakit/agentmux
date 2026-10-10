import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import base from './vitest.performance-reading.config.mts'
import currentSources from './vitest.mote-context.config.mts'

export default defineConfig({
  ...base,
  resolve: currentSources.resolve!,
  cacheDir: resolve(import.meta.dirname, '../../../.cache/persistence-inputs'),
  test: {
    ...base.test,
    include: [
      'apps/desktop/test/workbench-persistence-relevance.test.ts',
      'apps/desktop/test/ui-persistence-writer.test.ts',
      'apps/desktop/test/workbench-storage-authority.test.ts',
      'apps/desktop/test/workbench-storage-commit.test.ts'
    ]
  }
})
