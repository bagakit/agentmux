import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { staleDistComplaint } from '../../../vitest.dist-freshness'
import original from '../scripts/fixtures/demand-current-work/vitest.config.mts'
const repository = resolve(import.meta.dirname, '../../..')
// Providers embed the generated identity runtime. Consume its actual build, not a replacement implementation.
const identityIssue = await staleDistComplaint(resolve(repository, 'packages/identity'), 'dist/runtime-source.js')
if (identityIssue) throw new Error(identityIssue)
export default defineConfig({ ...original, resolve: { ...original.resolve, alias: [
  { find: /^@agentmux\/connectors$/, replacement: resolve(repository, 'packages/connectors/src/index.ts') },
  { find: /^@agentmux\/connectors\/adapters\/feishu$/, replacement: resolve(repository, 'packages/connectors/src/adapters/feishu/index.ts') },
  { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(repository, 'packages/identity/dist/runtime-source.js') },
  ...(original.resolve?.alias as Array<{ find: RegExp; replacement: string }> ?? [])
] }, test: { ...original.test, include: ['test/goal-completion-product.test.tsx'], maxWorkers: 1, passWithNoTests: false } })
