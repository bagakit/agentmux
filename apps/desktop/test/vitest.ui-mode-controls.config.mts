import { defineConfig, defaultExclude } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'
export default defineConfig({ ...owning, cacheDir: '.cache/ui-mode-controls', test: { ...owning.test,
  include: ['apps/desktop/test/ui-mode-controls.test.tsx', 'apps/desktop/test/surface-mode-switch.test.tsx',
    'apps/desktop/test/ui-goal-view-controls.test.tsx', 'apps/desktop/test/collaboration-focus-product.test.tsx',
    'apps/desktop/test/recall-notebook-views.test.tsx'],
  exclude: [...defaultExclude], passWithNoTests: false, fileParallelism: false, testTimeout: 30000 } })
