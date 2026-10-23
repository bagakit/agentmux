import { defineConfig } from 'vitest/config'
import source from './performance-capture.config.mts'
export default defineConfig({ ...source, test: { ...source.test,
  include: ['apps/desktop/test/host-resource-observer.test.ts', 'apps/desktop/test/host-resource-public.test.ts', 'apps/desktop/test/main-performance-diagnostics.test.ts',
    'apps/desktop/test/performance-stage-sampler.test.ts'], maxWorkers: 1 } })
