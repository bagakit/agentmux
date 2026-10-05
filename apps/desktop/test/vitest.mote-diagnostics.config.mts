import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

// Current public source and the existing installed dependencies; no pnpm install or old dist.
export default defineConfig({ ...source, cacheDir: resolve(source.root!, '.tmp/mote-diagnostics-vitest-cache'),
  test: { ...source.test, include: ['apps/desktop/test/mote-context-observation.test.tsx',
    'apps/desktop/test/desktop-client-observation.test.ts', 'apps/desktop/test/control-ipc-bridge.test.ts',
    'packages/core/test/control-client-observation.test.ts'], passWithNoTests: false, testTimeout: 20_000 }
})
