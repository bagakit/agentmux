import base from './vitest.hook-environment.config.mts'
import { defineConfig } from 'vitest/config'

export default defineConfig({ ...base,
  cacheDir: new URL('../../../.local/hook-durability/codex-claude-vitest', import.meta.url).pathname,
  test: { ...base.test, include: ['packages/core/test/codex-claude-retained-hook.test.ts'],
    testTimeout: 90_000, hookTimeout: 15_000 }
})
