import { defineConfig } from 'vitest/config'
import owning from './vitest.persistence-inputs.config.mts'

export default defineConfig({ ...owning,
  resolve: { ...owning.resolve, conditions: ['node', 'import', 'default'] },
  ssr: { ...owning.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  test: { ...owning.test,
  include: ['apps/desktop/test/browser-operation-identity.test.ts', 'apps/desktop/test/browser-operation-journal.test.ts', 'apps/desktop/test/browser-operation-window.test.ts', 'apps/desktop/test/browser-run-script-wiring.test.ts'],
  testNamePattern: /Browser operation identity|BrowserOperationJournal/,
  fileParallelism: false, maxWorkers: 1, globalSetup: [], setupFiles: [], passWithNoTests: false
} })
