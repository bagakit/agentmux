import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({
  ...original,
  root: resolve(import.meta.dirname, '../../../../..'),
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-project-history-cache/adjacent'),
  test: { ...original.test, include: ['apps/desktop/test/agent-focus-context.test.ts', 'apps/desktop/test/recent-focus-timeline.test.tsx', 'apps/desktop/test/focus-timeline-height.test.tsx', 'apps/desktop/test/focus-native-user-messages.integration.test.tsx', 'apps/desktop/test/focus-message-sender-association.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
