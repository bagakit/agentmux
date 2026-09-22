import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

export default defineConfig({
  ...original,
  root: resolve(import.meta.dirname, '../../../../..'),
  test: {
    ...original.test,
    include: [
      'apps/desktop/test/session-mailbox.test.tsx',
      'apps/desktop/test/session-mailbox-receipts.test.tsx'
    ],
    passWithNoTests: false,
    fileParallelism: false
  }
})
