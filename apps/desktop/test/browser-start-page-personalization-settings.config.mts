import { defineConfig } from 'vitest/config'
import owning from './browser-start-page.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  environment: 'happy-dom',
  include: ['apps/desktop/test/browser-start-page-settings.test.ts', 'apps/desktop/test/browser-start-page-personalization-settings.test.tsx'],
  testTimeout: 45000
} })
