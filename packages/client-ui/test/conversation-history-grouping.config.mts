import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'

export default defineConfig({ ...base, cacheDir: '.cache/conversation-history-grouping', test: { ...base.test,
  include: ['packages/client-ui/test/conversation-history-grouping.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
