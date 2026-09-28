import { defineConfig } from 'vitest/config'
import overviewConfig from '../settings-overview/vitest.config.mts'

// Exact UI slice; inherit real Core source aliases and normal Git setup without rebuilding shared dist.
export default defineConfig({
  ...overviewConfig,
  test: {
    ...overviewConfig.test,
    include: [
      'apps/desktop/test/settings-prompts-library.test.tsx',
      'apps/desktop/test/settings-prompts-save.test.tsx',
      'apps/desktop/test/status-prompt-settings.test.tsx',
      'apps/desktop/test/settings-resources-draft.test.tsx',
      'apps/desktop/test/settings-workbench.test.tsx',
      'apps/desktop/test/settings-draft-conflict.test.tsx',
      'apps/desktop/test/settings-resources-control.test.ts'
    ]
  }
})
