import { defineConfig } from 'vitest/config'
import original from '../scripts/fixtures/settings-overview/vitest.config.mts'

export default defineConfig({ ...original, esbuild: { jsx: 'automatic' },
  resolve: { ...original.resolve, conditions: ['browser', 'module', 'development|production'] },
  test: { ...original.test, include: ['apps/desktop/test/performance-sample-reading.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
