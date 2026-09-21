import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

export default defineConfig({
  ...original,
  root: resolve(import.meta.dirname, '../../../../..'),
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-message-sender-association-cache/native'),
  test: {
    ...original.test,
    include: ['apps/desktop/test/focus-native-user-messages.integration.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false
  }
})
