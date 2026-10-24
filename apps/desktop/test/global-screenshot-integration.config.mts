import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import screenshotShortcut from './screenshot-shortcut.config.mts'

// Share the production aliases and bounded source-mutation port; keep this
// composition check and its cache independent of the shortcut/composer suite.
export default defineConfig({
  ...screenshotShortcut,
  cacheDir: resolve(import.meta.dirname, '../../../.tmp/global-screenshot-integration-cache'),
  test: {
    ...screenshotShortcut.test,
    include: ['apps/desktop/test/global-screenshot-integration.test.ts']
  }
})
