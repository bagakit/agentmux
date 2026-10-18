import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './unified-identifiers.config.mts'
import { integratedIdentityMutations } from '../scripts/lib/integrated-identifier-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const key = process.env.AMUX_INTEGRATED_ID_MUTATION
const mutation = key ? integratedIdentityMutations[key] : undefined
if (key && !mutation) throw new Error('Unknown integrated identity mutation')
const selected = [...new Set(Object.values(integratedIdentityMutations).map(value => value.test))]
const inherited = source.resolve?.alias
const aliases = Array.isArray(inherited) ? inherited : Object.entries(inherited ?? {}).map(([find, replacement]) => ({ find, replacement }))
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...source,
  cacheDir: resolve(root, '.tmp/integrated-identifiers-cache', key ?? 'original'),
  resolve: { ...source.resolve, alias: [
    { find: /^@agentmux\/connectors$/u, replacement: resolve(root, 'packages/connectors/src/index.ts') },
    { find: /^@agentmux\/connectors\/adapters\/feishu$/u, replacement: resolve(root, 'packages/connectors/src/adapters/feishu/index.ts') },
    ...aliases
  ] },
  plugins: [{ name: 'integrated-identity-production-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps|packages)\//u.test(path) || path.includes('node_modules/')) return
    let code = source
    if (mutation?.file === path) {
      if (source.split(mutation.before).length !== 2) throw new Error('Missing unique actual allocator source: ' + key)
      code = source.replace(mutation.before, 'after' in mutation ? mutation.after : mutation.before.replace('mintObjectId()', 'crypto.randomUUID()'))
    }
    if (process.env.AMUX_INTEGRATED_ID_LOADED) appendFileSync(process.env.AMUX_INTEGRATED_ID_LOADED,
      JSON.stringify({ path, sourceSHA256: sha(source), loadedSHA256: sha(code), mutation: code === source ? null : key }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...source.test, include: mutation ? [mutation.test] : selected, environment: 'node',
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 30_000 }
})
