import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const aliases = ['core', 'demand', 'relay'].flatMap(name => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports).map(([key, value]: [string, any]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/' + name : '@agentmux/' + name + '/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: resolve(root, 'packages', name, value.import.replace('./dist/', name === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))
  }))
})
const mutations: Record<string, [string, string, string]> = {
  'kill-healthy-fork': ['packages/core/src/client.ts', 'if (durableCreate) {\n          if (!persisted)', 'if (false) {\n          if (!persisted)'],
  'ignore-fork-intent': ['packages/core/src/client.ts', 'JSON.stringify(existing.forkedFrom) !== JSON.stringify(forkSource) || existing.creation.intentDigest !== intentDigest', 'JSON.stringify(existing.forkedFrom) !== JSON.stringify(forkSource) || false'],
  'skip-fork-preparation': ['packages/core/src/client.ts', 'reservation = await this.registry.prepareCreate(reservation, preparedCreation!)', 'void preparedCreation'],
  'kill-prepared-recovery': ['packages/core/src/client.ts', "if (reservation.kind === 'create' && reservation.preparedCreation) {", 'if (false) {'],
  'skip-replay-auth': ['packages/core/src/client.ts', 'this.resolveMessageAuthor(input.initialMessage.capability, input.initialMessage.callerAgentSessionId, initialAuthor)', 'void initialAuthor']
}
export default defineConfig({ root, resolve: { alias: aliases }, plugins: [{ name: 'actual-fork-lifecycle-source', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!/^packages\/(?:core|demand|relay)\/src\//.test(path)) return
  let code = source
  const mutation = process.env.AMX_FORK_LIFECYCLE_MUTATION, change = mutation && mutations[mutation]
  if (mutation && !change) throw new Error('Unknown lifecycle source mutant')
  if (change && path === change[0]) {
    if (code.split(change[1]).length !== 2) throw new Error('Lifecycle source anchor is not unique: ' + mutation)
    code = code.replace(change[1], change[2])
  }
  if (process.env.AMX_FORK_LIFECYCLE_LOADED) appendFileSync(process.env.AMX_FORK_LIFECYCLE_LOADED, JSON.stringify({ path,
    originalSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'),
    ...(code !== source ? { mutation } : {}) }) + '\n')
  if (code !== source) return { code, map: null }
} }], test: { include: ['packages/core/test/current-fork-lifecycle.test.ts'], passWithNoTests: false, fileParallelism: false,
  maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000 } })
