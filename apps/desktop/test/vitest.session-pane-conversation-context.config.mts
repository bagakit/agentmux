import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.cache/session-pane-conversation-context', test: { ...base.test,
  include: ['apps/desktop/test/session-pane-conversation-context.test.tsx'], exclude: [], globalSetup: [], setupFiles: [],
  maxWorkers: 1, fileParallelism: false, testTimeout: 20000, passWithNoTests: false,
  server: { ...base.test?.server, sourcemap: false }
} })
