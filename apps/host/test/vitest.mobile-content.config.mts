import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import discovery from './vitest.mobile-discovery.config.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...discovery, resolve: { alias: [...(discovery.resolve!.alias as any[]),
  { find: /^@agentmux\/host\/(.+)$/u, replacement: resolve(root, 'apps/host/src/$1.ts') },
  { find: /^@agentmux\/client-ui\/note\/(.+)$/u, replacement: resolve(root, 'packages/client-ui/src/note/$1.ts') }
] }, test: { include: ['apps/host/test/mobile-desktop-content.test.ts'], maxWorkers: 1, fileParallelism: false } })
