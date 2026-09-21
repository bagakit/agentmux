import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

export default defineConfig({
  ...original,
  root: resolve(import.meta.dirname, '../../../../..'),
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-message-sender-association-cache/adjacent'),
  test: {
    ...original.test,
    include: [
      'apps/desktop/test/focus-human-message-markers.test.tsx',
      'apps/desktop/test/recent-focus-timeline.test.tsx',
      'apps/desktop/test/focus-running-timeline.test.tsx'
    ],
    passWithNoTests: false,
    fileParallelism: false
  }
})
