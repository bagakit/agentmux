import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
 'drop-spatial': ['packages/client-ui/src/lib/object-link-reference.ts','return { uri, target, ...(label ? { label } : {}) }',"return target.kind === 'agent' ? { uri, target, ...(label ? { label } : {}) } : null"],
 'wrong-open': ['apps/desktop/src/renderer/src/components/InlineObjectLink.tsx','api.ui.openObjectLink(uri)','api.ui.openObjectLink(id)'],
 'wrong-copy': ['apps/desktop/src/renderer/src/components/InlineObjectLink.tsx','copyTextToClipboard(uri,','copyTextToClipboard(id,'],
 'drop-document-gate': ['packages/client-ui/src/components/AgentMarkdown.tsx','!readOnly && !documentMode && renderObjectLink','!readOnly && renderObjectLink'],
 'unbound-copy': ['apps/desktop/src/renderer/src/components/InlineObjectLink.tsx','const copied = copiedUri === uri','const copied = copiedUri !== null'],
 'drop-host': ['apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx','renderObjectLink: reference => <InlineObjectLink {...reference} />','renderObjectLink: reference => reference.uri']
} as const
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alias = ['core', 'client-ui'].flatMap(pkg => Object.entries(JSON.parse(readFileSync(resolve(root, `packages/${pkg}/package.json`), 'utf8')).exports).flatMap(([key, value]) => {
  const entry = typeof value === 'string' ? { import: value } : value as { browser?: string; import?: string }
  const target = entry.browser ?? entry.import
  if (!target || target.endsWith('.css')) return []
  const name = `@agentmux/${pkg}` + (key === '.' ? '' : key.slice(1))
  const path = target.replace(/^\.\/dist\/(src\/)?/, './src/').replace(/\.js$/, '.ts')
  return [{ find: new RegExp('^' + name.split('*').map(escape).join('(.*)') + '$'), replacement: resolve(root, `packages/${pkg}`, path.replace('*', '$1')) }]
})).sort((a,b) => b.find.source.length - a.find.source.length)
export default defineConfig({ root, esbuild: { jsx: 'automatic' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  cacheDir: resolve(root, '.local/inline-agent-link-cache'), resolve: { alias, conditions: ['browser'] },
  plugins: [{ name: 'actual-input-markdown', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), mutation = process.env.OBJECT_LINK_MUTATION as keyof typeof mutations | undefined
    let code = source
    if (mutation) {
      const change = mutations[mutation]; assert.ok(change)
      if (path === change[0]) {
        const count = source.split(change[1]).length - 1
        assert.equal(count, 1, 'Actual loaded unique mutation target')
        code = source.replaceAll(change[1], change[2])
      }
    }
    const log = process.env.OBJECT_LINK_LOADED
    if (log && (path.startsWith('packages/') || path.startsWith('apps/desktop/src/'))) appendFileSync(log, JSON.stringify({ path,
      sourceSHA: createHash('sha256').update(source).digest('hex'), loadedSHA: createHash('sha256').update(code).digest('hex'), mutation, transformed: source !== code }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: { include: ['packages/client-ui/test/agent-link.test.tsx', 'apps/desktop/test/inline-agent-link.test.tsx'],
    environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
