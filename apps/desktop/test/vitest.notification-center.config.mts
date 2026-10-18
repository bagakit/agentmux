import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import source from './performance-capture.config.mts'

export default defineConfig({ ...source,
  cacheDir: resolve(import.meta.dirname, '../../../.cache/notification-center'),
  test: { ...source.test, include: ['apps/desktop/test/notification-center.test.tsx'], maxWorkers: 1 }
})
