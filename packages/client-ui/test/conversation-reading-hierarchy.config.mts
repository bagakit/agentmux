import { defineConfig } from 'vitest/config'
import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'

export default defineConfig({ ...base, cacheDir: '.cache/conversation-reading-hierarchy',
  test: { ...base.test, include: ['packages/client-ui/test/conversation-reading-hierarchy.test.tsx'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
