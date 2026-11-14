import { join, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { sourceAliases } from '../../host/test/goal-cross-host-source.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: sourceAliases.map(({ find, replacement }) => ({
  find: new RegExp('^' + find.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace('*', '(.*)') + '$', 'u'), replacement: replacement.replace('*', '$1')
})) }, test: { include: ['packages/demand/test/goal-plan.test.ts', 'packages/demand/test/goal-plan-revision.test.ts', 'apps/host/test/goal-plan-revision-product.test.ts'],
  setupFiles: [join(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false, testTimeout: 60_000, hookTimeout: 60_000 } })
