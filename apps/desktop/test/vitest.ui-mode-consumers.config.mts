import { defineConfig, defaultExclude } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'

export default defineConfig({ ...owning, cacheDir: '.cache/ui-mode-consumers', test: { ...owning.test,
  include: ['apps/desktop/test/ui-recall-mode-controls.test.tsx', 'apps/desktop/test/ui-goal-view-controls.test.tsx',
    'apps/desktop/test/collaboration-focus-product.test.tsx'],
  exclude: [...defaultExclude], passWithNoTests: false, fileParallelism: false, testTimeout: 30000
} })
