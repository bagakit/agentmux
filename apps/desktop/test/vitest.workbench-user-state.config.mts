import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

export default defineConfig({ ...base, cacheDir: '.cache/workbench-user-state', test: {
  ...base.test, include: ['apps/desktop/test/workbench-user-state.test.ts'], passWithNoTests: false
} })
