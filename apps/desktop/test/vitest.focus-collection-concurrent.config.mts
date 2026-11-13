import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'

export default defineConfig({ ...base, cacheDir: '.tmp/focus-collection-concurrent-vitest', test: { ...base.test,
  include: ['apps/desktop/test/focus-collection-concurrent.test.tsx'] } })
