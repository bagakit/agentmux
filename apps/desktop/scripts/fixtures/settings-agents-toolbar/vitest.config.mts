import { defineConfig } from 'vitest/config'
import original from '../settings-search-refinement/vitest.config.mts'

export default defineConfig({
  ...original,
  test: { ...original.test, include: [
    'apps/desktop/test/settings-product-polish.test.tsx',
    'apps/desktop/test/settings-executor-refresh-input.test.tsx'
  ] }
})
