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
aliases.push(
  { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/components/$1.tsx') },
  { find: /^@agentmux\/client-ui\/platform$/, replacement: resolve(root, 'packages/client-ui/src/platform.tsx') },
  { find: /^@agentmux\/client-ui\/(?!styles\/)(.+)$/, replacement: resolve(root, 'packages/client-ui/src/lib/$1.ts') }
)
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'branch-status-owning-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/apps/desktop/src/')) return
    let code = source
    if (process.env.AMX_BRANCH_STYLE_MUTATION) {
      const item = JSON.parse(readFileSync(process.env.AMX_BRANCH_STYLE_MUTATION, 'utf8'))
      if (file === resolve(root, item.file)) { assert.equal(source.split(item.before).length - 1, 1, 'Unique actual source mutation'); code = source.replace(item.before, item.after) }
    }
    if (process.env.AMX_BRANCH_STYLE_LOADED) appendFileSync(process.env.AMX_BRANCH_STYLE_LOADED,
      JSON.stringify({ file: relative(root, file), sourceSHA256: createHash('sha256').update(source).digest('hex'), mutated: code !== source }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: { include: ['apps/desktop/test/branches-panel.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
