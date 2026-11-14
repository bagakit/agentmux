import { defineConfig } from 'vitest/config'
import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'

export default defineConfig({ ...base, cacheDir: '.cache/conversation-default-process',
  test: { ...base.test, include: ['packages/client-ui/test/conversation-default-process.test.tsx'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20000 } })
