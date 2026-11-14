import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import base from './vitest.focus-project-appearance.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const selected = process.env.AGENTMUX_FOCUS_READ_MUTANT
const mutations = {
  'widen-selection': ["read.selection.kind === 'members' ? read.selection.references", "false ? read.selection.references"],
  'ignore-host': ['groups.get(JSON.stringify(read.scope))', "directory.find(([, candidate]) => candidate.scope.kind === read.scope.kind)?.[1]"]
} as const
if (selected && !(selected in mutations)) throw Error('Unknown Focus read source inverse')
let applied = false
export default defineConfig({ ...base, cacheDir: '.tmp/focus-read-projection-cache',
  resolve: { ...base.resolve, alias: ['focus-control', 'focus-task-guidance', 'agent-input-submit'].map(name => ({
    find: '@agentmux/core/' + name, replacement: resolve(root, 'packages/core/src/' + name + '.ts')
  })).concat(base.resolve!.alias as []) },
  plugins: [{ name: 'actual-focus-read-source', enforce: 'pre', transform(code, id) {
    if (!selected || relative(root, id.split('?')[0]!) !== 'apps/desktop/src/renderer/src/lib/focus-read-projection.ts') return
    const [before, after] = mutations[selected as keyof typeof mutations]
    if (code.split(before).length !== 2) throw Error('One actual Focus read source anchor required')
    applied = true; process.stderr.write('MUTATION_APPLIED=' + selected + '\n')
    return { code: code.replace(before, after), map: null }
  }, buildEnd() { if (selected && !applied) throw Error('Actual Focus read source inverse not consumed') } }],
  test: { ...base.test, include: ['apps/desktop/test/focus-read-projection.test.ts'], passWithNoTests: false }
})
