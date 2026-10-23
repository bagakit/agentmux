import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_LIFECYCLE_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'notice-without-applied-operation': { path: 'packages/connectors/src/publication-host.ts',
    before: "if (original?.state !== 'applied' || !original.notices?.some(item => item.deliveryOperationId === notice.operationId && item.event === source.event)) return false",
    after: 'if (false) return false' },
  'revive-revoked-member': { path: 'packages/connectors/src/room-binding.ts',
    before: 'const grant = { ...original, revision: original.revision + 1, bindingRevision: binding.revision, connectionId: binding.connectionId }',
    after: "const grant = { ...original, state: 'active', revision: original.revision + 1, bindingRevision: binding.revision, connectionId: binding.connectionId }" },
  'retain-pause-cut': { path: 'packages/connectors/src/room-binding.ts',
    before: "const binding: RoomBinding = { ...current, state: 'active', revision: current.revision + 1, ...cut }",
    after: "const binding: RoomBinding = { ...current, state: 'active', revision: current.revision + 1 }" }
}
if (mutation && !mutations[mutation]) throw Error('Unknown lifecycle mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/group-lifecycle', mutation ?? 'original'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/u, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'actual-lifecycle-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/connectors/src/') && path !== 'packages/connectors/src/connection-services.ts') return
    const selected = mutation ? mutations[mutation] : undefined, originalSHA256 = createHash('sha256').update(code).digest('hex')
    if (selected?.path === path) {
      if (code.split(selected.before).length !== 2) throw Error('Lifecycle mutation anchor missing or ambiguous')
      code = code.replace(selected.before, selected.after)
    }
    if (process.env.AGENTMUX_LIFECYCLE_LOADED) appendFileSync(process.env.AGENTMUX_LIFECYCLE_LOADED, JSON.stringify({ path, originalSHA256, loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: selected?.path === path ? mutation : null }) + '\n')
    if (selected?.path === path) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], fileParallelism: false, passWithNoTests: false,
    include: ['packages/connectors/test/group-lifecycle-public-consumer.test.ts', 'packages/connectors/test/room-binding.test.ts', 'packages/connectors/test/room-binding-public-consumer.test.ts'] }
})
