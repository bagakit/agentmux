import { defineConfig } from 'vitest/config'
import base from './vitest.ui-controls-owning.config.mts'

export default defineConfig({ ...base, cacheDir: '.cache/ui-composer-controls', test: { ...base.test,
  environment: 'happy-dom', setupFiles: ['apps/mobile/test/device-locks.ts'],
  include: ['apps/mobile/test/composer-tool-groups.test.tsx', 'apps/desktop/test/composer-tool-groups.test.tsx',
    'apps/mobile/test/mobile-command-entry.test.tsx', 'apps/desktop/test/composer-input-ownership.test.tsx'],
  passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
