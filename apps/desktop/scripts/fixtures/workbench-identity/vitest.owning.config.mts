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
const mutations = {
  navigation: ['apps/desktop/src/renderer/src/components/WorkspaceTopicsPanel.tsx', '{ tabId, ...(groupId === undefined ? {} : { groupId }) }', '{ tabId }'],
  highlight: ['apps/desktop/src/renderer/src/components/WorkbenchTopology.tsx', 'data-subject-region={tab.highlightedRegionIds?.includes(region.regionId) || undefined}', 'data-subject-region={undefined}'],
  consumer: ['apps/desktop/src/renderer/src/components/TopicRowPresence.tsx', '{ highlightedRegionIds: [subject.regionId] }', '{ highlightedRegionIds: undefined }'],
  location: ['apps/desktop/src/renderer/src/components/WorkbenchTopology.tsx', '{inspected?.locationLabel ? <small>{inspected.locationLabel}</small> : null}', '{null}']
} as const
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
 esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
 resolve: { conditions: ['browser', 'import', 'default'], alias: [...clientUiAliases, ...aliases,
  { find: 'react', replacement: resolve(root, 'apps/desktop/node_modules/react') },
  { find: 'react-dom', replacement: resolve(root, 'apps/desktop/node_modules/react-dom') }] },
 ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
 cacheDir: resolve(root, '.tmp/workbench-identity/vitest-cache'),
 plugins: [{ name: 'actual-workbench-identity', enforce: 'pre', transform(code, id) {
  const file = id.split('?')[0]!, path = relative(root, file)
  if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
  const mutation = process.env.AGENTMUX_IDENTITY_MUTATION as keyof typeof mutations | undefined
  let output = code
  if (mutation && mutations[mutation]?.[0] === path) {
    const [, needle, replacement] = mutations[mutation]
    if (code.split(needle).length !== 2) throw new Error('Mutation must match the original loaded implementation exactly once: ' + mutation)
    output = code.replace(needle, replacement)
  }
  if (process.env.AGENTMUX_IDENTITY_LOADED) appendFileSync(process.env.AGENTMUX_IDENTITY_LOADED,
    JSON.stringify({ path, sha256: createHash('sha256').update(output).digest('hex'), originalSHA256: createHash('sha256').update(code).digest('hex'), mutated: output !== code }) + '\n')
  return output !== code ? { code: output, map: null } : undefined
 }}],
 test: { include: ['apps/desktop/test/workbench-identity.test.tsx','apps/desktop/test/topic-occurrence-navigation.test.tsx','apps/desktop/test/topic-selection-cost.test.tsx',
   'apps/desktop/test/mote-icon-identity.test.tsx','apps/desktop/test/agent-avatar-settings.test.tsx'],
   passWithNoTests: false, fileParallelism: false, testTimeout: 15000, globalSetup: [],
   setupFiles: [resolve(root,'vitest.setup.ts')], server: { deps: { inline: ['@agentmux/client-ui'] } } }
})
