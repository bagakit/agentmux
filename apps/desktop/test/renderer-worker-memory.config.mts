import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import owning from './vitest.performance-reading.config.mts'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...owning, root,
  resolve: { ...owning.resolve, conditions: ['node', 'import', 'default'] },
  ssr: { ...owning.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  cacheDir: process.env.T026_UNIT_CACHE ?? resolve(root, '.cache/renderer-worker-memory'),
  test: { ...owning.test, environment: 'node', maxWorkers: 1, fileParallelism: false, passWithNoTests: false,
    include: ['apps/desktop/test/renderer-worker-memory.test.ts', 'apps/desktop/test/renderer-memory.test.ts', 'apps/desktop/test/performance-scene.test.ts'], testTimeout: 15000 } })
