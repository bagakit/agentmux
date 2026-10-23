import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_GROUP_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'omit-group-record': { path: 'packages/connectors/src/durable-ingress.ts', before: 'try { intake = await this.recordGroup(intake) }', after: 'try { intake = intake }' },
  'omit-input-capability': { path: 'packages/connectors/src/durable-ingress.ts', before: " || !grant.capabilities.includes('input')", after: '' }
}
if (mutation && !mutations[mutation]) throw Error('Unknown group conversation mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/group-conversation'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/u, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'actual-group-conversation-owner', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/connectors/src/') && !path.startsWith('packages/core/dist/') && !['packages/connectors/src/connection-services.ts', 'apps/host/src/external-input-authority.ts'].includes(path)) return
    const selected = mutation ? mutations[mutation] : undefined, originalSHA256 = createHash('sha256').update(code).digest('hex')
    if (selected?.path === path) {
      if (code.split(selected.before).length !== 2) throw Error('Group conversation mutation anchor missing or ambiguous')
      code = code.replace(selected.before, selected.after)
    }
    if (process.env.AGENTMUX_GROUP_LOADED) appendFileSync(process.env.AGENTMUX_GROUP_LOADED, JSON.stringify({ path, fileSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), originalSHA256, sha256: createHash('sha256').update(code).digest('hex'), mutation: selected?.path === path ? mutation : null }) + '\n')
    if (selected?.path === path) return { code, map: null }
  } }],
  test: { ...original.test, fileParallelism: false, passWithNoTests: false,
    include: ['packages/connectors/test/group-conversation-record.test.ts'] }
})
