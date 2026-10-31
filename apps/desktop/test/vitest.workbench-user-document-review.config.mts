import { defineConfig } from 'vitest/config'
import base from './vitest.workbench-user-storage.config.mts'

export default defineConfig({ ...base, cacheDir: '.tmp/workbench-user-document-review-cache', test: {
  ...base.test, include: ['apps/desktop/test/workbench-user-document-review.test.ts'], passWithNoTests: false
} })
