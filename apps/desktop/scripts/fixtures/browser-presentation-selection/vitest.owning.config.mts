import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mutations, owners } from './mutations.mjs'

const root = resolve(import.meta.dirname, '../../../../..')
const aliases = ['core', 'layout', 'demand', 'client-ui'].flatMap(name => {
  const directory = resolve(root, 'packages', name), metadata = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  return Object.entries(metadata.exports ?? {}).flatMap(([key, value]: [string, any]) => {
    const entry = typeof value === 'string' ? value : value.browser ?? value.import
    if (key.includes('*') && entry?.startsWith('./src/')) {
      const prefix = (metadata.name + key.slice(1)).split('*').map((part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
      return [{ find: new RegExp('^' + prefix + '$'), replacement: resolve(directory, entry.replace('*', '$1')) }]
    }
    if (!entry?.startsWith('./dist/') && !entry?.startsWith('./src/')) return []
    const stem = resolve(directory, 'src', entry.slice(entry.startsWith('./src/') ? 6 : 7).replace(/\.[jt]sx?$/, ''))
    const target = [stem + '.ts', stem + '.tsx', stem + '/index.ts'].find(existsSync)
    return target ? [{ find: key === '.' ? metadata.name : metadata.name + key.slice(1), replacement: target }] : []
  })
}).sort((a, b) => String(b.find).length - String(a.find).length)
const rpc = readdirSync(resolve(root, 'node_modules/.pnpm')).filter(name => name.startsWith('json-rpc-2.0@')).sort().at(-1)
assert.ok(rpc, 'Existing declared json-rpc dependency must be available')
aliases.push({ find: 'json-rpc-2.0', replacement: createRequire(resolve(root, 'node_modules/.pnpm', rpc, 'node_modules/json-rpc-2.0/package.json')).resolve('json-rpc-2.0') })
const desktopRequire = createRequire(resolve(root, 'apps/desktop/package.json'))
const clientDependencies = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).dependencies
const runtimeDependencies = Object.keys(clientDependencies).filter(name => !name.startsWith('@agentmux/'))
for (const name of [...runtimeDependencies, 'react/jsx-dev-runtime', 'react/jsx-runtime', 'react-dom/client', 'react-dom', 'react']) aliases.unshift({ find: new RegExp('^' + name.replaceAll('/', '\\/') + '$'), replacement: desktopRequire.resolve(name) })
export default defineConfig({ root, resolve: { alias: aliases }, esbuild: { jsx: 'automatic' },
  define: { __AGENTMUX_WEB_PREVIEW__: 'false' },
  plugins: [{ name: 'loaded-presentation-selection-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/apps/desktop/src/')) return
    let code = source
    // Keep the maintained typed fixture factory for a real Pane caller; Native IPC has separate proof.
    if (file === resolve(root, 'apps/desktop/src/renderer/src/lib/api.ts')) {
      const entry = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
      assert.equal(source.split(entry).length - 1, 1, 'Existing typed API fixture seam')
      code = source.replace(entry, 'export const api = mockApi')
    }
    const variant = process.env.AGENTMUX_PRESENTATION_SELECTION_MUTATION
    const baseline = process.env.AGENTMUX_PRESENTATION_SELECTION_BASELINE
    if (baseline && (file === resolve(root, owners.stage) || file === resolve(root, owners.selector))) {
      code = readFileSync(resolve(baseline, file === resolve(root, owners.stage) ? 'BrowserPresentationStage.tsx' : 'selector.ts'), 'utf8')
    }
    if (variant) {
      const mutation = mutations[variant as keyof typeof mutations]
      assert.ok(mutation, 'Known actual loaded mutation')
      if (file === resolve(root, owners[mutation[0]])) {
        assert.equal(source.split(mutation[1]).length - 1, 1, 'Unique loaded Source mutation anchor')
        code = source.replace(mutation[1], mutation[2])
      }
    }
    if (process.env.AGENTMUX_PRESENTATION_SELECTION_LOADED) appendFileSync(process.env.AGENTMUX_PRESENTATION_SELECTION_LOADED,
      JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(source).digest('hex'),
        loadedSHA256: createHash('sha256').update(code).digest('hex'), variant: variant ?? null, baseline: Boolean(baseline), modified: code !== source }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  cacheDir: resolve(root, '.tmp/presentation-selection-vitest-cache'),
  test: { include: ['apps/desktop/test/browser-presentation-selection-caller.test.tsx', 'apps/desktop/test/browser-presentation-selection.test.tsx', 'apps/desktop/test/browser-presentation-registration-recovery.test.tsx'],
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 5000 }
})
