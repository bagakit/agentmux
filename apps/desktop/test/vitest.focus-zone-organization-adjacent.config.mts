import { defineConfig } from 'vitest/config'
import source from './vitest.focus-zone-organization.config.mts'
export default defineConfig({ ...source, cacheDir: '.tmp/focus-zone-organization-adjacent-cache',
  test: { ...source.test, include: ['apps/desktop/test/focus-project-appearance.test.tsx', 'apps/desktop/test/focus-project-preferences-races.test.tsx',
    'apps/desktop/test/focus-project-zone-grouping.test.tsx', 'apps/desktop/test/focus-collection-layout.test.tsx', 'apps/desktop/test/focus-timeline-project-scope.test.tsx'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
