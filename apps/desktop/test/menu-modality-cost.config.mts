import { defineConfig } from 'vitest/config'
import source from '../scripts/fixtures/settings-overview/vitest.config.mts'

// This slice consumes the real menu dependency and source UI adapters. It does
// not load shared Core dist while independent Core work is being qualified.
export default defineConfig({
  ...source,
  test: {
    ...source.test,
    include: ['apps/desktop/test/menu-modality-cost.test.tsx', 'apps/desktop/test/hover-dropdown-menu.test.tsx']
  }
})
