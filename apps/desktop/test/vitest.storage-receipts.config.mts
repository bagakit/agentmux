import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
export default defineConfig({ ...base, cacheDir: '.tmp/storage-receipts-vitest', test: { ...base.test,
  include: ['apps/desktop/test/storage-save-receipts.test.ts'], passWithNoTests: false } })
