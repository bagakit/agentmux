import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../../../..')
const aliases = ['core', 'relay', 'demand', 'identity', 'git', 'layout'].flatMap(pkg => {
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
 cacheDir: resolve(root, '.cache/conversation-latest-auto-owning'),
 plugins: [{ name: 'actual-unified-input', enforce: 'pre', transform(source, id) {
  const file = id.split('?')[0]!; if (!file.startsWith(root + '/apps/desktop/src/') && !file.startsWith(root + '/packages/') && file !== resolve(root, 'apps/desktop/test/conversation-latest-auto.integration.test.tsx')) return
  let code = source
  const mutation = process.env.AGENTMUX_LATEST_CONTROL_MUTATION
  if (mutation && file === resolve(root, 'apps/desktop/src/renderer/src/components/ActivityView.tsx')) {
   const replacements: Record<string, [string, string]> = {
    'transient-visibility': ['const needsReturnToLatest = showJump && (!atLoadedTail || readingWindow.currentOutside) || readingWindow.historical', 'const needsReturnToLatest = conversationReading?.opened || showJump || readingWindow.historical || readingWindow.newerOutside'],
    'loaded-return-refresh': ['if (readingWindow.historical || readingWindow.newerOutside || readingWindow.held) {', 'if (conversationReading?.opened || readingWindow.historical || readingWindow.hasEarlierNavigation || readingWindow.newerOutside || readingWindow.held) {'],
    'disable-automatic-latest': ['readingWindow.showLatestAutomatically()', 'void 0 /* Source mutation: no automatic current catch-up */']
   }
   const replacement = replacements[mutation]
   if (!replacement || source.split(replacement[0]).length !== 2) throw Error('Unknown or non-unique latest-control mutation: ' + mutation)
   code = source.replace(...replacement)
  }
  const log = process.env.AGENTMUX_UNIFIED_LOADED
  if (log) appendFileSync(log, JSON.stringify({ path: relative(root, file), bytes: Buffer.byteLength(code), sha256: createHash('sha256').update(code).digest('hex'),
   originalSHA256: createHash('sha256').update(source).digest('hex'), ...(code !== source ? { mutation } : {}) }) + '\n')
  return code === source ? undefined : { code, map: null }
 }}],
 test: { include: ['apps/desktop/test/conversation-latest-auto.integration.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000,
  globalSetup: [], setupFiles: [], server: { deps: { inline: ['@agentmux/client-ui'] } } }
})
