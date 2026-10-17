import source from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...source, cacheDir: '.local/reading-integration/archive-cache',
  test: { ...source.test, include: ['apps/desktop/test/reading-client-incident.test.ts', 'apps/desktop/test/reading-client-archive.test.ts'],
    passWithNoTests: false, testTimeout: 30_000 } })
