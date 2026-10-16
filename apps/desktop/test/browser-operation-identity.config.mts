import { defineConfig } from 'vitest/config'
import owning from './vitest.persistence-inputs.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['apps/desktop/test/browser-operation-identity.test.ts', 'apps/desktop/test/browser-operation-journal.test.ts', 'apps/desktop/test/browser-run-script-wiring.test.ts', 'apps/desktop/test/agent-address.test.ts'],
  testNamePattern: /Browser operation identity|BrowserOperationJournal|每个控制错误码都被显式分类过/,
  fileParallelism: false, maxWorkers: 1, globalSetup: [], setupFiles: [], passWithNoTests: false
} })
