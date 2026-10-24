import { readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { instrumentDiscoverySource } from './mobile-discovery-mutations.mjs'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
// These consumers execute the selected source owners, including the separate Node
// Host's source loader. They do not claim a compiled application/package result.
const core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const exact = Object.entries(core).flatMap(([key, entry]) => {
  const source = (entry as { types?: string }).types
  return source?.startsWith('./dist/') ? [{ find: key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2), replacement: resolve(root, 'packages/core/src', source.slice(7).replace(/\.d\.ts$/u, '.ts')) }] : []
}).sort((a, b) => b.find.length - a.find.length)
export default defineConfig({ plugins: [{ name: 'original-discovery-source', enforce: 'pre', transform(source, id) { const value = instrumentDiscoverySource(source, relative(root, id.split('?')[0]!)); return value === source ? null : value } }], resolve: { alias: [...exact,
  { find: /^@agentmux\/client-ui\/(display-name|conversation-recap|agent-presentation|focus-state-mark|attention-vocabulary|activity-working-state)$/u,
    replacement: resolve(root, 'packages/client-ui/src/lib/$1.ts') }] },
  test: { include: ['apps/host/test/mobile-desktop-discovery.test.ts', 'apps/host/test/spatial-presentation.test.ts'], maxWorkers: 1, fileParallelism: false } })
