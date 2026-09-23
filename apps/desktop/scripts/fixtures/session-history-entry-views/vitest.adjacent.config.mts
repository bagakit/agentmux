import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({
  ...original,
  root: resolve(import.meta.dirname, '../../../../..'),
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/session-history-entry-views-cache/adjacent'),
  test: { ...original.test, include: ['apps/desktop/test/agent-region-identity-menu.test.tsx', 'apps/desktop/test/session-native-history-surface.test.tsx', 'apps/desktop/test/activity-view-wiring.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
