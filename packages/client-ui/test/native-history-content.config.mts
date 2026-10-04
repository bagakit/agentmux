import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alias = Object.entries(JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports).flatMap(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { import: string }).import
  if (!target || !target.endsWith('.js')) return []
  return [{ find: new RegExp('^' + escape('@agentmux/core' + (key === '.' ? '' : key.slice(1))) + '$'),
    replacement: resolve(root, 'packages/core', target.replace('/dist/', '/src/').replace(/\.js$/, '.ts')) }]
}).sort((a,b) => b.find.source.length - a.find.source.length)
alias.unshift({ find: /^@noble\/hashes\/(.*)$/, replacement: resolve(root, 'packages/core/node_modules/@noble/hashes/$1') })
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/defensive-limits-root-fix/event-history-vite-cache'),
  server: { watch: { ignored: ['**/.tmp/**', '**/docs/**', '**/.local/**'], followSymlinks: false } },
  resolve: { alias }, esbuild: { jsx: 'automatic' },
  plugins: [{ name: 'actual-content-consumer-mutation', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), mutation = process.env.EVENT_HISTORY_UI_MUTATION
    let code = source
    if (mutation === 'copy-shell' && path === 'packages/client-ui/src/components/ConversationMessage.tsx') {
      const target = "if (part.kind !== 'resource' || part.resourceType !== 'text') complete.push(part)"
      assert.equal(source.split(target).length - 1, 1, 'Unique actual whole-message copy source')
      code = source.replace(target, 'if (true) complete.push(part)')
    }
    if (process.env.EVENT_HISTORY_LOADED && path.startsWith('packages/')) appendFileSync(process.env.EVENT_HISTORY_LOADED,
      JSON.stringify({ path, mutation, sourceSHA: createHash('sha256').update(source).digest('hex'),
        loadedSHA: createHash('sha256').update(code).digest('hex'), transformed: source !== code }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: { include: ['packages/client-ui/test/native-history-content.test.tsx'], environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1 } })
