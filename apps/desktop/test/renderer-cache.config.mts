import { defineConfig } from 'vitest/config'
import original from './renderer-v8-profile.config.mts'
export default defineConfig({ ...original, cacheDir: '.local/state/performance-release-advice/cache/vitest',
  resolve: { ...original.resolve, conditions: ['node', 'import', 'default'] },
  ssr: { ...original.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  test: { ...original.test, include: ['apps/desktop/test/renderer-cache.test.ts'], testTimeout: 30000 } })
