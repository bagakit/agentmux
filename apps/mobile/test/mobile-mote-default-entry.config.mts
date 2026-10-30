import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const aliases = ['core', 'client-ui', 'identity', 'relay'].flatMap(name => {
  const manifest = JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`), 'utf8'))
  return Object.entries(manifest.exports).flatMap(([key, entry]: [string, any]) => {
    let source = typeof entry === 'string' ? entry : entry.browser ?? entry.types
    if (typeof source !== 'string') return []
    if (source.startsWith('./dist/')) source = source.replace('./dist/', './src/').replace(/\.d\.ts$/u, '.ts')
    const find = `@agentmux/${name}${key === '.' ? '' : key.slice(1)}`
    const replacement = resolve(root, `packages/${name}`, source)
    return !source.includes('*') && !existsSync(replacement) ? [] : [{ find, replacement }]
  })
}).sort((a, b) => b.find.length - a.find.length).map(value => ({
  find: new RegExp('^' + value.find.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('(.+)') + '$', 'u'),
  replacement: value.replacement.replace('*', '$1')
}))
const mutations: Record<string, { before: string; after: string }> = {
  'bottom-entry': { before: "if (value === 'mote') { void enterMote(recentMoteSpaceId); return }", after: "if (value === 'mote') { setHome('mote'); setSecondary(null); setShowSession(false); return }" },
  'row-entry': { before: 'void enterMote(id)', after: 'setRecentMoteSpaceId(id)' },
  'late-entry': { before: 'if (!isCurrent()) return\n      const owners', after: 'if (false) return\n      const owners' },
  'exact-object': { before: 'mobileChatStart({ ...catalog, spaces: [owner] }, owner.spaceId)', after: 'mobileChatStart(catalog, owner.spaceId)' }
}
const name = process.env.AGENTMUX_TEST_MOTE_ENTRY_MUTATION
if (name && !mutations[name]) throw new Error('Unknown Mote entry mutation: ' + name)
export default defineConfig({ root,
  plugins: [{ name: 'loaded-mobile-mote-default-entry', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== resolve(root, 'apps/mobile/src/MobileApp.tsx')) return
    const mutation = name ? mutations[name]! : null
    if (mutation && source.split(mutation.before).length !== 2) throw new Error('Mote entry mutation marker changed: ' + name)
    const code = mutation ? source.replace(mutation.before, mutation.after) : source
    const marker = { name: name ?? 'baseline', file: id, originalSha256: createHash('sha256').update(source).digest('hex'), loadedSha256: createHash('sha256').update(code).digest('hex') }
    if (process.env.AGENTMUX_TEST_MOTE_ENTRY_TRACE) appendFileSync(process.env.AGENTMUX_TEST_MOTE_ENTRY_TRACE, JSON.stringify({ phase: 'loaded', ...marker }) + '\n')
    return { code: code + '\n;globalThis.__mobileMoteEntryEvaluated = ' + JSON.stringify(marker) + ';\n', map: null }
  } }], esbuild: { jsx: 'automatic' },
  resolve: { alias: [...aliases, { find: 'react-dom', replacement: resolve(root, 'apps/mobile/node_modules/react-dom') },
    { find: 'react', replacement: resolve(root, 'apps/mobile/node_modules/react') }] },
  test: { include: ['apps/mobile/test/mobile-mote-default-entry.test.tsx'], environment: 'happy-dom',
    setupFiles: [resolve(root, 'apps/mobile/test/device-locks.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, restoreMocks: true, testTimeout: 20000 }
})
