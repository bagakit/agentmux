import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { resolve, relative } from 'node:path'
import discovery from './vitest.mobile-discovery.config.mjs'
import { instrumentWorkspaceSource } from './mobile-workspace-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(resolve(root, 'apps/mobile/package.json'))
export default defineConfig({ ...discovery, plugins: [...(discovery.plugins ?? []), { name: 'original-mobile-workspace-source', enforce: 'pre', transform(source, id) {
  const value = instrumentWorkspaceSource(source, relative(root, id.split('?')[0]!)); return value === source ? null : value
} }], resolve: { alias: [...['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'].map(key => ({ find: new RegExp('^' + key + '$'), replacement: require.resolve(key) })), ...(discovery.resolve!.alias as any[]),
  { find: /^@agentmux\/client-ui\/theme$/u, replacement: resolve(root, 'packages/client-ui/src/theme/index.ts') },
  { find: /^@agentmux\/host\/(.+)$/u, replacement: resolve(root, 'apps/host/src/$1.ts') }
] }, test: { include: ['apps/host/test/mobile-desktop-workspace.test.tsx'], maxWorkers: 1, fileParallelism: false } })
