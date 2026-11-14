import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
export default defineConfig({ ...base, cacheDir: base.cacheDir + '-executor-setup', test: { ...base.test,
  include: ['apps/desktop/test/mote-executor-setup.test.tsx'], passWithNoTests: false, testTimeout: 60000, maxWorkers: 1 } })
