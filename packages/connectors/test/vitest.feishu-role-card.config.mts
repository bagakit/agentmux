import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.feishu-reply.config.mts'
export default defineConfig({ ...original, cacheDir: resolve(import.meta.dirname, '../../../.cache/feishu-role-card'),
  test: { ...original.test, include: ['packages/connectors/test/feishu-role-card.test.ts'] } })
