import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.tmp/focus-collection-layout-vitest', test: { ...base.test,
  include: ['apps/desktop/test/focus-collection-layout.test.tsx'], testTimeout: 20000 } })
