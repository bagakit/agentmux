import { defineConfig } from 'vitest/config'
import base from './vitest.performance-reading.config.mts'
import owning from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'

export default defineConfig({ ...base, resolve: owning.resolve!, ssr: owning.ssr!,
  test: { ...base.test, environment: 'node', include: ['apps/desktop/test/browser-cold-owner.test.ts'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, globalSetup: [], setupFiles: [] }
})
