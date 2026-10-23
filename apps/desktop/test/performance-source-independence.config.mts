import { defineConfig } from 'vitest/config'
import source from './performance-capture.config.mts'
export default defineConfig({ ...source, test: { ...source.test,
  include: ['apps/desktop/test/performance-source-independence.test.ts', 'apps/desktop/test/process-resource-sampler.test.ts',
    'apps/desktop/test/performance-stage-sampler.test.ts', 'apps/desktop/test/toolkit-owner.test.ts'], maxWorkers: 1 } })
