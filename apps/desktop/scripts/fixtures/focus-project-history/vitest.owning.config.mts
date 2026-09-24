import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({
  ...original,
  root: resolve(import.meta.dirname, '../../../../..'),
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-project-history-cache/owning'),
  test: { ...original.test, include: ['apps/desktop/test/focus-project-history-timeline.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
