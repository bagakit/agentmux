import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../vitest.config'

// Exact owning files: unregistered evidence copies below .tmp are not another candidate.
export default mergeConfig(base, defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    include: [
      'apps/desktop/test/process-resource-sampler.test.ts',
      'apps/desktop/test/resource-usage-panel.test.ts',
      'apps/desktop/test/resource-usage-observability.test.tsx',
      'apps/desktop/test/resource-usage-ipc-lifecycle.test.ts',
      'apps/desktop/test/resource-usage-collapsed.test.tsx',
      'apps/desktop/test/runtime-resource-observation.test.ts',
      'apps/desktop/test/resource-usage-style.test.ts'
    ],
    maxWorkers: 1
  }
}))
