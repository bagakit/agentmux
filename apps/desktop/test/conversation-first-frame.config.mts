import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-first-frame', test: { ...base.test,
  include: ['packages/client-ui/test/conversation-first-frame.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
