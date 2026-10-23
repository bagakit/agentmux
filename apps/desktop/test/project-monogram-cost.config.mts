import { defineConfig } from 'vitest/config'
import source from './vitest.performance-reading.config.mts'
export default defineConfig({ ...source, test: { ...source.test,
  include: ['apps/desktop/test/project-monogram.test.ts', 'apps/desktop/test/project-monogram-cost.test.tsx'], maxWorkers: 1 } })
