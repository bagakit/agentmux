import { defineConfig } from 'vitest/config'
import base from './mote-private-threads.config.mts'
export default defineConfig({ ...base, cacheDir: '.tmp/mote-session-reading', test: { ...base.test,
  include: ['apps/desktop/test/mote-session-reading.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
