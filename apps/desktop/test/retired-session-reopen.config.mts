import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const mutations = {
  'all-hosts': [
    'client.sessionHistorySources({ agentSessionId: reference.agentSessionId })',
    'this.sessionHistorySources()'
  ],
  'all-sessions': [
    'client.sessionHistorySources({ agentSessionId: reference.agentSessionId })',
    'client.sessionHistorySources()'
  ]
} as const

export default defineConfig({
  root,
  resolve: { alias: Object.entries(core.exports).map(([key, entry]) => ({
    find: key === '.' ? '@agentmux/core' : '@agentmux/core' + key.slice(1),
    replacement: resolve(root, 'packages/core', (entry as { import: string }).import.replace('/dist/', '/src/').replace(/\.js$/, '.ts'))
  })).sort((a, b) => b.find.length - a.find.length) },
  plugins: [{ name: 'retired-reopen-source', enforce: 'pre', transform(source, id) {
    if (id !== resolve(root, 'apps/desktop/src/main/runtime-controller.ts')) return
    let code = source
    const mutation = process.env.AGENTMUX_REOPEN_MUTATION as keyof typeof mutations | undefined
    if (mutation) {
      assert.ok(Object.hasOwn(mutations, mutation))
      const [before, after] = mutations[mutation]
      assert.equal(source.split(before).length - 1, 1, 'Mutate exactly the original reopen source read')
      code = source.replace(before, after)
    }
    if (process.env.AGENTMUX_REOPEN_LOADED) appendFileSync(process.env.AGENTMUX_REOPEN_LOADED,
      JSON.stringify({ source: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(code).digest('hex'), mutation: mutation ?? null }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: {
    include: ['apps/desktop/test/retired-session-reopen-ipc.test.ts', 'apps/desktop/test/remote-executor-lifecycle.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false
  }
})
