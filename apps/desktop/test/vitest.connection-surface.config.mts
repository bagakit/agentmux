import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.AGENTMUX_CONNECTION_SURFACE_MUTANT
const mutations = {
  'policy-only-summary': { path: 'apps/desktop/src/renderer/src/lib/connector-group-status.ts', before: 'const out = report?.outgoing.value', after: 'const out = false ? report?.outgoing.value : null' }
} as const
if (mutant && !(mutant in mutations)) throw Error('Unknown connection surface mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/connection-surface'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'loaded-connection-surface', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!), before = code
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/connectors/src/')) return
    const selected = mutant ? mutations[mutant as keyof typeof mutations] : null
    if (selected?.path === path) { if (code.split(selected.before).length !== 2) throw Error('Connection surface mutation anchor changed'); code = code.replace(selected.before, selected.after) }
    if (process.env.AGENTMUX_CONNECTION_SURFACE_LOADED && /\.tsx?$/.test(path)) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.AGENTMUX_CONNECTION_SURFACE_LOADED, JSON.stringify({ path, originalSHA256: sha(before), loadedSHA256: sha(code), mutation: code === before ? null : mutant }) + '\n')
    }
    return code === before ? undefined : { code, map: null }
  } }], test: { ...original.test, fileParallelism: false, passWithNoTests: false, include: ['apps/desktop/test/connector-header-status.test.tsx'] }
})
