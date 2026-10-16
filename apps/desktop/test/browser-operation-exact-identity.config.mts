import { defineConfig } from 'vitest/config'
import owning from './browser-operation-identity.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: [...owning.test!.include!, 'apps/desktop/test/browser-operation-exact-identity.test.ts'],
  testNamePattern: /Browser operation (identity|exact identity)|BrowserOperationJournal|每个控制错误码都被显式分类过/,
  fileParallelism: false, maxWorkers: 1, globalSetup: [], setupFiles: [], passWithNoTests: false
} })
