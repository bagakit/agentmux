import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.tmp/derived-actions-settings-vitest', test: { ...base.test,
  include: ['apps/desktop/test/settings-derived-actions.test.tsx', 'apps/desktop/test/settings-home.test.tsx'], testTimeout: 25000 } })
