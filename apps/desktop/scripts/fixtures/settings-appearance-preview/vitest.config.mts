import { defineConfig } from 'vitest/config'
import overviewConfig from '../settings-overview/vitest.config.mts'

// The existing radio/draft contracts consume actual Source aliases, never shared dist.
export default defineConfig({
  ...overviewConfig,
  test: {
    ...overviewConfig.test,
    include: [
      'apps/desktop/test/settings-radio-keyboard.test.tsx',
      'apps/desktop/test/settings-draft-conflict.test.tsx'
    ]
  }
})
