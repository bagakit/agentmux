import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../../../..')
const aliases = ['core', 'relay', 'demand'].flatMap(pkg => {
 const manifest = JSON.parse(readFileSync(resolve(root, `packages/${pkg}/package.json`), 'utf8'))
 return Object.entries(manifest.exports).flatMap(([key, value]) => {
  const target = (value as { import: string }).import
  const path = resolve(root, `packages/${pkg}/src/` + target.replace(/^\.\/dist\/(src\/)?/u, '').replace(/\.js$/u, '.ts'))
  const name = `@agentmux/${pkg}` + (key === '.' ? '' : key.slice(1))
  return existsSync(path) ? [{ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: path }] : []
 })
})
const clientUi = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8'))
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const clientUiAliases = Object.entries(clientUi.exports).flatMap(([key, value]) => {
 const target = typeof value === 'string' ? value : (value as { browser?: string; import?: string }).browser ?? (value as { import?: string }).import
 if (!target) return []
 const name = '@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))
 return [{ find: new RegExp('^' + name.split('*').map(escape).join('(.*)') + '$'), replacement: resolve(root, 'packages/client-ui', target.replace('*', '$1')) }]
}).sort((a, b) => b.find.source.length - a.find.source.length)
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
 esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
 resolve: { conditions: ['browser', 'import', 'default'], alias: [...clientUiAliases, ...aliases,
  { find: 'react', replacement: resolve(root, 'apps/desktop/node_modules/react') },
  { find: 'react-dom', replacement: resolve(root, 'apps/desktop/node_modules/react-dom') }] },
 ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
 cacheDir: resolve(root, '.cache/activity-unified-owning'),
 plugins: [{ name: 'actual-unified-input', enforce: 'pre', transform(code, id) {
  const file = id.split('?')[0]!; if (!file.startsWith(root + '/apps/desktop/src/') && !file.startsWith(root + '/packages/') && file !== resolve(root, 'apps/desktop/test/activity-unified-history.integration.test.tsx') && file !== resolve(root, 'apps/desktop/test/activity-reading-demand.test.tsx') && file !== resolve(root, 'apps/desktop/test/conversation-selected-head-reading.test.tsx')) return
  const log = process.env.AGENTMUX_UNIFIED_LOADED
  if (log) appendFileSync(log, JSON.stringify({ path: relative(root, file), bytes: Buffer.byteLength(code), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
 }}],
 test: { include: ['apps/desktop/test/activity-unified-history.integration.test.tsx', 'apps/desktop/test/activity-reading-demand.test.tsx', 'apps/desktop/test/conversation-selected-head-reading.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000,
  globalSetup: [], setupFiles: [], server: { deps: { inline: ['@agentmux/client-ui'] } } }
})
