import { defineConfig } from 'vitest/config'
import original from '../toolkit-preferences/vitest.config.mts'

export default defineConfig({ ...original, plugins: [],
  resolve: { ...original.resolve, conditions: ['browser', 'module', 'import'] },
  test: { ...original.test, include: ['apps/desktop/test/toolkit-current-link.test.tsx'], passWithNoTests: false }
})
