import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'

export default defineConfig({ ...base, cacheDir: '.tmp/focus-group-heading-menu-vitest', test: { ...base.test,
  include: ['apps/desktop/test/focus-group-heading-menu.test.tsx'], testTimeout: 20000 } })
