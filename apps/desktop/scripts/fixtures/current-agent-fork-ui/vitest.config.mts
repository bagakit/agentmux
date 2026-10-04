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
aliases.push({ find: /^@agentmux\/layout$/, replacement: resolve(root, 'packages/core/src/spatial-layout.ts') })
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases, conditions: ['browser'] },
  plugins: [{ name: 'fork-ui-current-source', enforce: 'pre',
    resolveId(id) { if (/(^|\/)ConversationView(?:\.js)?$/.test(id)) return '\0fork-unused-conversation' },
    load(id) { if (id === '\0fork-unused-conversation') return 'export function ConversationView(){throw new Error("Unrelated ConversationView invoked in current-fork UI proof")}' },
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
