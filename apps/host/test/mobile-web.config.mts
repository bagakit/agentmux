import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/mobile-web-test', process.env.MOBILE_WEB_TEST_MUTANT ?? 'normal'),
  test: { include: ['apps/host/test/mobile-web.test.ts', 'apps/host/test/mobile-web-owner.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    environment: 'node', passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 60_000, hookTimeout: 30_000 } })
