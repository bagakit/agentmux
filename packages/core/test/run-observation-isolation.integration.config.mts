import { defineConfig } from 'vitest/config'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import base from '../../../vitest.config.ts'

const setupFiles = base.test?.setupFiles ?? []
const root = resolve(import.meta.dirname, '../../..')
// Node bin discovery also checks the shared dependency installation. Vite expands
// those URL candidates while collecting Renderer modules; allow only that bin root.
const sharedBin = resolve(dirname(realpathSync(resolve(root, 'node_modules/.pnpm'))), '../packages/core/bin')
export default defineConfig({
  ...base,
  cacheDir: resolve(root, '.tmp/run-observation-integration'),
  server: { fs: { allow: [root, sharedBin] } },
  test: {
    ...base.test,
    include: [
      'apps/desktop/test/focus-stop-agent-private-runtime.integration.test.ts',
      'apps/desktop/test/terminal-input-authority.integration.test.tsx',
      'packages/core/test/run-attachment-native.integration.test.ts'
    ],
    testNamePattern: 'Stop targets one exact private Run|real private owner process restart|private Native',
    setupFiles: [...(Array.isArray(setupFiles) ? setupFiles : [setupFiles]), resolve(import.meta.dirname, 'helpers/run-observation-private-state.ts')],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
    testTimeout: 90_000, hookTimeout: 30_000
  }
})
