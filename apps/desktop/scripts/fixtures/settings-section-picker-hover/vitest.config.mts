import { defineConfig } from 'vitest/config'
import settingsSource from '../settings-search-refinement/vitest.config.mts'

// UI source exports and the established real setup; no shared dist rebuild or compiled Core claim.
export default defineConfig({
  ...settingsSource,
  test: {
    ...settingsSource.test,
    include: [
      'apps/desktop/test/settings-section-picker-hover.test.tsx',
      'apps/desktop/test/settings-workbench.test.tsx',
      'apps/desktop/test/settings-save-feedback.test.tsx',
      'apps/desktop/test/focus-toolbar-focus-return.test.tsx'
    ],
    maxWorkers: 1
  }
})
