import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import discovery from './vitest.mobile-discovery.config.mjs'
import { instrumentGoalsSource } from './mobile-goals-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...discovery, plugins: [...(discovery.plugins ?? []), { name: 'original-goals-source', enforce: 'pre', transform(source, id) { const value = instrumentGoalsSource(source, relative(root, id.split('?')[0]!), 'vitest-transform'); return value === source ? null : value } }],
  resolve: { alias: [...(discovery.resolve!.alias as any[]), { find: /^@agentmux\/host\/(.+)$/u, replacement: resolve(root, 'apps/host/src/$1.ts') },
    { find: /^@agentmux\/client-ui\/note\/(.+)$/u, replacement: resolve(root, 'packages/client-ui/src/note/$1.ts') }] },
  test: { include: ['apps/host/test/mobile-desktop-goals.test.ts'], maxWorkers: 1, fileParallelism: false } })
