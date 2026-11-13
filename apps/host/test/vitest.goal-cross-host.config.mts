import { defineConfig } from 'vitest/config'
import { sourceAliases, instrumentCrossHostSource } from './goal-cross-host-source.mjs'
export default defineConfig({
  plugins: [{ name: 'goal-cross-host-source-owner', enforce: 'pre', transform(source, id) {
    const loaded = instrumentCrossHostSource(source, id.split('?')[0]!, 'host-core')
    return loaded === source ? null : loaded
  } }],
  resolve: { alias: sourceAliases.map(({ find, replacement }) => ({ find: new RegExp('^' + find.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace('*', '(.*)') + '$', 'u'), replacement: replacement.replace('*', '$1') })) },
  test: { include: ['apps/host/test/goal-cross-host-product.test.ts'], maxWorkers: 1, fileParallelism: false, testTimeout: 60_000, hookTimeout: 30_000 }
})
