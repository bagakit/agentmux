import { defineConfig, defaultExclude } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'
export default defineConfig({ ...owning, cacheDir: '.cache/ui-mode-controls', test: { ...owning.test,
  include: ['apps/desktop/test/ui-mode-controls.test.tsx', 'apps/desktop/test/surface-mode-switch.test.tsx'],
  exclude: [...defaultExclude], passWithNoTests: false, fileParallelism: false, testTimeout: 30000 } })
