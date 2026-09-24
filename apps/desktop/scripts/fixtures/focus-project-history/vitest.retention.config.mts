import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({
  ...original,
  root: resolve(import.meta.dirname, '../../../../..'),
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-project-history-cache/retention'),
  test: { ...original.test, include: ['apps/desktop/test/focus-history-retention.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
