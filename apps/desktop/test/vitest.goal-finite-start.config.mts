import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import original from '../scripts/fixtures/mote-daily-goal/vitest.config.mts'
const repository = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, resolve: { ...original.resolve, alias: [
  { find: /^@agentmux\/connectors$/, replacement: resolve(repository, 'packages/connectors/src/index.ts') },
  { find: /^@agentmux\/connectors\/adapters\/feishu$/, replacement: resolve(repository, 'packages/connectors/src/adapters/feishu/index.ts') },
  { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(repository, 'packages/identity/dist/runtime-source.js') },
  ...(original.resolve?.alias as Array<{ find: RegExp; replacement: string }> ?? [])
] }, test: { ...original.test, include: ['test/goal-start-product.test.tsx', 'test/goal-discussion-recipient.test.tsx', 'test/goal-continuation-receipt.test.tsx', 'test/goal-workflow-restart.test.tsx', '../../packages/demand/test/demand-start-version.test.ts'], passWithNoTests: false, maxWorkers: 1 } })
