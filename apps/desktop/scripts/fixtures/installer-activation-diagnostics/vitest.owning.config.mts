import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...original,
  root,
  cacheDir: resolve(root, '.tmp/installer-activation-diagnostics-20261004/cache'),
  test: {
    ...original.test,
    // These Node tests import source only; no compiled Core or Runtime/GUI action.
    globalSetup: [],
    environment: 'node',
    include: ['apps/desktop/test/package-process-scope.test.ts', 'apps/desktop/test/installer-activation-diagnostics.test.ts'],
    passWithNoTests: false,
    fileParallelism: false
  }
})
