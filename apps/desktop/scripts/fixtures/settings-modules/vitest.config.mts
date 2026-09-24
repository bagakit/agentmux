import { defineConfig } from 'vitest/config'
import overviewConfig from '../settings-overview/vitest.config.mts'

// Preserve the existing source aliases, preview environment and git setup; add only this slice.
export default defineConfig({
  ...overviewConfig,
  test: {
    ...overviewConfig.test,
    include: [
      ...overviewConfig.test!.include!,
      'apps/desktop/test/settings-modules.test.tsx',
      'apps/desktop/test/settings-modules-control.test.ts',
      'apps/desktop/test/settings-control.test.ts',
      'apps/desktop/test/settings-preferences-control.test.ts'
    ]
  }
})
