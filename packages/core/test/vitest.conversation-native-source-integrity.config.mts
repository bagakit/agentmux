import { defineConfig } from 'vitest/config'
import base from '../../../apps/desktop/test/vitest.activity-current-signatures.config.mts'

export default defineConfig({ ...base, cacheDir: '.cache/conversation-native-source-integrity',
  test: { ...base.test, environment: 'node', include: ['packages/core/test/conversation-native-source-integrity.test.ts'],
    fileParallelism: false, maxWorkers: 1, testTimeout: 20_000, passWithNoTests: false } })
