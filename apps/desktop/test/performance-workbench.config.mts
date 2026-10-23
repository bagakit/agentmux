import { defineConfig } from 'vitest/config'
import source from './v8-profile-analysis.config.mts'
import measured from '../scripts/fixtures/performance-panel/vitest.config.mts'
export default defineConfig({ ...source, plugins: [...source.plugins ?? [], ...measured.plugins ?? []], test: { ...source.test,
  include: ['apps/desktop/test/performance-workbench.test.tsx', 'apps/desktop/test/performance-capture.test.tsx',
    'apps/desktop/test/performance-panel-interaction.test.tsx', 'apps/desktop/test/performance-themed-controls.test.tsx', 'apps/desktop/test/toolkit-agent-cards-performance.test.tsx'],
  maxWorkers: 1 } })
