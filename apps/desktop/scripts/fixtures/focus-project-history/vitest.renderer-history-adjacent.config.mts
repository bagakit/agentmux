import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({ ...original, root: resolve(import.meta.dirname, '../../../../..'),
  server: { fs: { allow: [resolve(import.meta.dirname, '../../../../..'), ...['core', 'demand', 'layout'].map(name => realpathSync(resolve(import.meta.dirname, '../../../../..', 'packages', name)))] } },
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-retired-history-renderer-cache/adjacent'),
  test: { ...original.test, include: ['apps/desktop/test/focus-native-user-messages.integration.test.tsx', 'apps/desktop/test/focus-message-sender-association.test.tsx', 'apps/desktop/test/focus-project-history-timeline.test.tsx', 'apps/desktop/test/focus-message-overlay.test.tsx'], passWithNoTests: false, fileParallelism: false } })
