import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'skip-input-grammar': ['packages/client-ui/src/components/AgentMarkdown.tsx', '!documentMode && !isInput && !looksLikeMarkdown(content)', '!documentMode && !looksLikeMarkdown(content)'],
  'drop-heading-marker': ['packages/client-ui/src/components/AgentMarkdown.tsx', 'context.inputMode && node.sourceMarker', 'false && node.sourceMarker'],
  'drop-source-marker': ['packages/client-ui/src/lib/agent-markdown.ts', '...(sourceMarker ? { sourceMarker } : {})', '...{}'],
  'drop-input-caller': ['packages/client-ui/src/components/ConversationMessage.tsx', 'inputMode={inputMarkdown}', 'inputMode={false}'],
  'drop-reading-range': ['packages/client-ui/src/components/ConversationMessage.tsx', 'sessionHistoryTextForReading(part)', 'part.text'],
  'copy-reading-body': ['packages/client-ui/src/components/ConversationMessage.tsx', "if (part.kind === 'text') return part.text", "if (part.kind === 'text') return sessionHistoryTextForReading(part)"],
  'drop-captured-channel': ['packages/core/src/session-user-messages.ts', '...(item.sourceChannel === undefined ? {} : { channel: item.sourceChannel }),', ''],
  'drop-title-slot': ['packages/client-ui/src/components/ConversationMessage.tsx', '<div className="log-turn__title">', '<div className="removed-title-slot">'],
  'drop-meta-row': ['packages/client-ui/src/components/ConversationMessage.tsx', '<div className="log-turn__meta">', '<div className="removed-meta-row">'],
  'wrong-native-caption': ['packages/client-ui/src/lib/conversation-input-source.ts', '原生 - 未知来源', 'Terminal · Local']
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
  cacheDir: resolve(root, '.local/input-markdown-cache'), resolve: { alias, conditions: ['browser'] },
  plugins: [{ name: 'actual-input-markdown', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), mutation = process.env.INPUT_READING_MUTATION as keyof typeof mutations | undefined
    let code = source
    if (mutation) {
      const change = mutations[mutation]; assert.ok(change)
      if (path === change[0]) {
        const count = source.split(change[1]).length - 1
        assert.equal(count, mutation === 'drop-input-caller' ? 3 : 1, 'Actual loaded unique mutation target')
        code = source.replaceAll(change[1], change[2])
      }
    }
    const log = process.env.INPUT_READING_LOADED
    if (log && (path.startsWith('packages/') || path.startsWith('apps/desktop/src/'))) appendFileSync(log, JSON.stringify({ path,
      sourceSHA: createHash('sha256').update(source).digest('hex'), loadedSHA: createHash('sha256').update(code).digest('hex'), mutation, transformed: source !== code }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: { include: ['packages/client-ui/test/input-markdown.test.tsx', 'packages/client-ui/test/markdown-semantics.test.tsx', 'packages/client-ui/test/markdown-outline.test.tsx', 'apps/desktop/test/conversation-input-origin.test.tsx'],
    environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
