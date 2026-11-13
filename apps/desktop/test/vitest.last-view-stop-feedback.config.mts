import source from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'

export default defineConfig({ ...source, cacheDir: '.tmp/last-view-stop-feedback-vitest',
  test: { ...source.test, globalSetup: [], setupFiles: [], passWithNoTests: false,
    include: ['apps/desktop/test/agent-last-view-split-close.test.tsx',
      'apps/desktop/test/agent-last-view-close.test.ts', 'apps/desktop/test/workbench-view-close.test.ts'] } })
