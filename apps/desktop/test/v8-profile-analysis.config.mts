import { defineConfig } from 'vitest/config'
import source from './performance-capture.config.mts'
export default defineConfig({ ...source, test: { ...source.test,
  include: ['packages/core/test/v8-profile-analysis.test.ts', 'apps/desktop/test/performance-capture.test.tsx'],
  maxWorkers: 1 } })
