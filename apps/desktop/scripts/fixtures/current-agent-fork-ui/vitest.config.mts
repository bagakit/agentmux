import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases = Object.entries(manifest.exports).map(([key, value]: [string, any]) => ({
  find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: resolve(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
const clientUiExports = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
for (const [key, value] of Object.entries(clientUiExports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
  const target = typeof value === 'string' ? value : (value as { browser: string }).browser
  const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui/' + key.slice(2)
  const pattern = name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
  aliases.push({ find: new RegExp('^' + pattern + '$'), replacement: resolve(root, 'packages/client-ui', target).replace('*', '$1') })
}
aliases.push({ find: /^@agentmux\/layout$/, replacement: resolve(root, 'packages/core/src/spatial-layout.ts') })
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases, conditions: ['browser'] },
  plugins: [{ name: 'fork-ui-current-source', enforce: 'pre',
    transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!file.startsWith('apps/desktop/src/') && !file.startsWith('packages/core/src/')) return
    let code = source
    if (process.env.AMX_FORK_UI_MUTATION) {
      const mutation = JSON.parse(readFileSync(process.env.AMX_FORK_UI_MUTATION, 'utf8'))
      if (file === mutation.file) {
        if (source.split(mutation.before).length !== 2) throw new Error('Loaded fork UI mutation must have one anchor')
        code = source.replace(mutation.before, mutation.after)
      }
    }
    if (process.env.AMX_FORK_UI_LOADED) appendFileSync(process.env.AMX_FORK_UI_LOADED, JSON.stringify({ file,
      sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutated: code !== source }) + '\n')
    if (code !== source) return { code, map: null }
  } }], test: { include: ['apps/desktop/test/current-agent-fork-ui.test.tsx'], passWithNoTests: false,
    fileParallelism: false, maxWorkers: 1, testTimeout: 10000 } })
