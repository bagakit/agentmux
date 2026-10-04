import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases = Object.entries(manifest.exports).map(([key, value]: [string, any]) => ({
  find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: resolve(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
aliases.push({ find: /^@agentmux\/layout$/, replacement: resolve(root, 'packages/core/src/spatial-layout.ts') })
const clientUi = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8'))
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const clientUiAliases = Object.entries(clientUi.exports).flatMap(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { browser?: string }).browser
  if (!target) return []
  const name = '@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))
  return [{ find: new RegExp('^' + name.split('*').map(escape).join('(.*)') + '$'), replacement: resolve(root, 'packages/client-ui', target.replace('*', '$1')) }]
}).sort((a, b) => b.find.source.length - a.find.source.length)
aliases.unshift(...clientUiAliases)
aliases.push(
  { find: /^react$/, replacement: resolve(root, 'apps/desktop/node_modules/react') },
  { find: /^react-dom$/, replacement: resolve(root, 'apps/desktop/node_modules/react-dom') }
)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' }, resolve: { alias: aliases, conditions: ['browser'] },
  plugins: [{ name: 'native-session-owning-source', enforce: 'pre',
    transform(source, id) {
      const path = id.split('?')[0]!
      if (!path.startsWith(root + '/apps/desktop/src/') && !path.startsWith(root + '/packages/core/src/')) return
      let code = source
      if (process.env.AGENTMUX_NATIVE_UI_MUTATION_PATH) {
        const item = JSON.parse(readFileSync(process.env.AGENTMUX_NATIVE_UI_MUTATION_PATH, 'utf8'))
        if (path === resolve(root, item.file)) { assert.equal(source.split(item.before).length - 1, 1, 'Unique loaded mutation'); code = source.replace(item.before, item.after) }
      }
      if (process.env.AGENTMUX_NATIVE_UI_LOADED_PATH) appendFileSync(process.env.AGENTMUX_NATIVE_UI_LOADED_PATH,
        JSON.stringify({ path: relative(root, path), sourceSHA256: digest(source), loadedSHA256: digest(code), mutated: code !== source }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }],
  test: { include: ['apps/desktop/test/native-session-change.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 10000 }
})
