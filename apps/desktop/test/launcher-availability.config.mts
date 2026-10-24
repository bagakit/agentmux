import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { sourceAliases } from '../scripts/fixtures/bookmark-local-link/vitest.owning.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  root, resolve: { alias: sourceAliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: {
    include: ['apps/desktop/test/launcher-availability-recovery.test.tsx',
      'apps/desktop/test/startup-agent-availability.test.tsx', 'apps/desktop/test/executor-draft-detection.test.tsx'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false, testTimeout: 20000
  }
})
