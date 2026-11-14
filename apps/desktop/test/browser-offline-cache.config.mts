import { defineConfig } from 'vitest/config'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const alias = Object.entries(core.exports).flatMap(([key, target]: [string, any]) => {
  const path = resolve(root, 'packages/core', (typeof target === 'string' ? target : target.import).replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
  return existsSync(path) ? [{ find: '@agentmux/core' + (key === '.' ? '' : key.slice(1)), replacement: path }] : []
}).sort((a, b) => b.find.length - a.find.length)
const mutants: Record<string, [string, string, string]> = {
  'unknown-replay': ['apps/desktop/src/main/browser-profile-storage.ts', 'if (prior) {', 'if (prior && false) {'],
  'selected-keys': ['apps/desktop/src/main/browser-profile-storage.ts', 'selected.storageKeys.some(key => !site.storageKeys.includes(key))', 'false'],
  'save-before-dispatch': ['apps/desktop/src/main/browser-profile-storage.ts', 'await this.ports.save(input.profileId, receipt, true)', 'void 0'],
  'owner-path': ['apps/desktop/src/main/browser-profile-storage-inventory.ts', "if (basename(path) === hash(facts.identifier + '-1'))", 'if (false)'],
  'partition-key': ['apps/desktop/src/main/browser-profile-storage-inventory.ts', 'group.keys.add(facts.key)', "group.keys.add(facts.key.split('^')[0]!)"]
}
const selected = process.env.AGENTMUX_OFFLINE_CACHE_MUTANT
if (selected && !mutants[selected]) throw new Error('Unknown offline cache source mutation')
let applied = false
export default defineConfig({ root, resolve: { alias },
  cacheDir: resolve(root, '.bagakit/feature-tracker/browser-offline-cache-management/main-cache', selected ?? 'baseline'),
  plugins: [{ name: 'offline-cache-source-proof', enforce: 'pre', transform(code, id) {
    if (!selected || relative(root, id.split('?')[0]!) !== mutants[selected]![0]) return
    const [, before, after] = mutants[selected]!
    if (code.split(before).length !== 2) throw new Error('Exact original offline cache mutation must match once')
    applied = true; return { code: code.replace(before, after), map: null }
  }, buildEnd() { if (selected && !applied) throw new Error('Selected offline cache mutation was not consumed') } }],
  test: { include: ['apps/desktop/test/browser-offline-cache.test.ts', 'apps/desktop/test/browser-offline-cache-preload.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
