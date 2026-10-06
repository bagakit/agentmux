import { defineConfig } from 'vitest/config'
import settings from '../settings-themes/vitest.config.mts'
export default defineConfig({
  ...settings,
  test: { ...settings.test, include: ['apps/desktop/test/builtin-themes.test.ts'], environment: 'happy-dom' }
})
