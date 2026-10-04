import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const sources: Record<string, string> = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(readFileSync(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) : {}
const aliases = ['core', 'relay', 'demand', 'client-ui'].flatMap(pkg => {
 const manifest = JSON.parse(readFileSync(resolve(root, `packages/${pkg}/package.json`), 'utf8'))
 return Object.entries(manifest.exports).flatMap(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { types?: string; import?: string }).types ?? (value as { import?: string }).import
  if (!target) return []
  const path = resolve(root, `packages/${pkg}/` + target.replace(/^\.\/dist\/(src\/)?/u, 'src/').replace(/\.js$/u, '.ts'))
  const name = '@agentmux/' + pkg + (key === '.' ? '' : key.slice(1))
  const wildcard = path.includes('*')
  const present = wildcard ? existsSync(path.slice(0, path.indexOf('*'))) : existsSync(path)
  return present ? [{ find: new RegExp('^' + name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '(.+)') + '$'), replacement: path.replace('*', '$1') }] : []
 })
})
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
 esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
 resolve: { conditions: ['browser', 'import', 'default'], alias: [...aliases.sort((a, b) => String(b.find).length - String(a.find).length),
  { find: 'react', replacement: resolve(root, 'apps/desktop/node_modules/react') },
  { find: 'react-dom', replacement: resolve(root, 'apps/desktop/node_modules/react-dom') }] },
 ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
 cacheDir: resolve(root, '.cache/performance-reading'),
 plugins: [{ name: 'actual-performance-inputs', enforce: 'pre', transform(code, id) {
  const file = id.split('?')[0]!, log = process.env.AGENTMUX_PERFORMANCE_LOADED
  const value = sources[relative(root, file)] ?? code
  if (log && (file.startsWith(root + '/apps/desktop/src/') || file.startsWith(root + '/packages/'))) appendFileSync(log,
    JSON.stringify({ path: relative(root, file), bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') }) + '\n')
  if (relative(root, file) in sources) return { code: value, map: null }
 }}],
 test: { include: ['apps/desktop/test/activity-reading-demand.test.tsx', 'apps/desktop/test/session-pane-reading-demand.test.tsx', 'apps/desktop/test/session-pane-native-covered-content-resume.test.tsx', 'apps/desktop/test/presentation-geometry-demand.test.tsx',
  'apps/desktop/test/browser-view-manager.test.ts', 'apps/desktop/test/native-overlay-regions.test.ts', 'apps/desktop/test/native-overlay-chrome.test.tsx', 'apps/desktop/test/native-overlay-pointer.test.tsx',
  'apps/desktop/test/mote-avatar-motion.test.tsx', 'apps/desktop/test/activity-ruler-reading-follow.integration.test.tsx'],
  passWithNoTests: false, fileParallelism: false, testTimeout: 15000, globalSetup: [], setupFiles: [],
  server: { deps: { inline: ['@agentmux/client-ui'] } } }
})
