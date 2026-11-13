import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

export default defineConfig({ ...base, cacheDir: base.cacheDir + '-main-entry-surface',
  test: { ...base.test, include: ['apps/desktop/test/mote-main-entry-surface.test.tsx'], passWithNoTests: false, testTimeout: 60000, maxWorkers: 1 } })
