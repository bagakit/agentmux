import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  ...base,
  cacheDir: resolve(root, '.tmp/workface-save-integrity'),
  test: { ...base.test, include: ['apps/desktop/test/workface-save-integrity.test.ts', 'apps/desktop/test/desktop-spatial-state.test.ts',
    'apps/desktop/test/desktop-spatial-store.test.ts', 'apps/desktop/test/spatial-workbench-checkpoint.test.ts',
    'apps/desktop/test/desktop-spatial-latest-intent.test.ts', 'apps/desktop/test/cross-device-project-groups.test.ts',
    'apps/desktop/test/name-authority.test.ts', 'apps/desktop/test/launcher-position-ipc.test.ts'],
  globalSetup: [], passWithNoTests: false, fileParallelism: false }
})
