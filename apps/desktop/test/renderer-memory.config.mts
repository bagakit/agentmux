import { defineConfig } from 'vitest/config'
import original from './renderer-v8-profile.config.mts'
export default defineConfig({ ...original, cacheDir: '.cache/renderer-memory',
  test: { ...original.test, include: ['apps/desktop/test/renderer-memory.test.ts', 'apps/desktop/test/renderer-memory-native.test.ts'], testTimeout: 30000 } })
