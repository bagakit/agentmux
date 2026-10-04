import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alias = ['core', 'client-ui'].flatMap(pkg => Object.entries(JSON.parse(readFileSync(resolve(root, `packages/${pkg}/package.json`), 'utf8')).exports).flatMap(([key, value]) => {
  const entry = typeof value === 'string' ? { import: value } : value as { browser?: string; import?: string }
  const target = entry.browser ?? entry.import
  if (!target || target.endsWith('.css')) return []
  const name = `@agentmux/${pkg}` + (key === '.' ? '' : key.slice(1))
  const path = target.replace(/^\.\/dist\/(src\/)?/, './src/').replace(/\.js$/, '.ts')
  return [{ find: new RegExp('^' + name.split('*').map(escape).join('(.*)') + '$'), replacement: resolve(root, `packages/${pkg}`, path.replace('*', '$1')) }]
})).sort((a,b) => b.find.source.length - a.find.source.length)
alias.unshift({ find: new RegExp('^' + escape(resolve(root, 'packages/core/dist')) + '/(.*)[.]js$'), replacement: resolve(root, 'packages/core/src/$1.ts') })
alias.unshift({ find: /^(?:[.][.]\/)+packages\/core\/dist\/(.*)[.]js$/, replacement: resolve(root, 'packages/core/src/$1.ts') })
export default defineConfig({ root, esbuild: { jsx: 'automatic' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  cacheDir: resolve(root, '.local/question-reply-reading-cache'), resolve: { alias, conditions: ['browser'] },
  plugins: [{ name: 'actual-question-window-input', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), mutation = process.env.QUESTION_READING_MUTATION
    const log = process.env.QUESTION_READING_LOADED
    if (log && (path.startsWith('packages/') || path.startsWith('apps/desktop/src/'))) appendFileSync(log, JSON.stringify({ path,
      sourceSHA: createHash('sha256').update(source).digest('hex'), loadedSHA: createHash('sha256').update(source).digest('hex'), mutation, transformed: false }) + '\n')
  } }],
  test: { include: ['apps/desktop/test/conversation-question-window.integration.test.tsx'],
    environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
