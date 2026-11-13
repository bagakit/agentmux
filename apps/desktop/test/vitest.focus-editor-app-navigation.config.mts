import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'

export default defineConfig({ ...base, cacheDir: '.tmp/focus-editor-app-navigation-vitest',
  test: { ...base.test, setupFiles: ['vitest.setup.ts'], include: ['apps/desktop/test/focus-editor-app-navigation.test.tsx'], testTimeout: 20000 } })
