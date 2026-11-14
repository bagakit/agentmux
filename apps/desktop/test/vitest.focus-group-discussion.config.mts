import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import base from './vitest.focus-project-appearance.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'no-confirmation': ['renderer/src/lib/focus-group-task.ts', '${confirmation}', ''],
  'wrong-project': ['renderer/src/components/FocusGroupDiscussion.tsx', 'openFocusGroupAgentLauncher(project, prompt, current)', 'openFocusGroupAgentLauncher(useAppStore.getState().config!.workspaces.find(p => p.id === useAppStore.getState().activeWorkspaceId)!, prompt, current)'],
  'all-members': ['renderer/src/lib/focus-group-task.ts', 'const byKey = new Map(contexts.map', 'refs.splice(0, refs.length, ...contexts.map(context => ({hostId: context.hostId, id: context.id}))); const byKey = new Map(contexts.map']
} as const
const selected = process.env.AGENTMUX_FOCUS_GROUP_MUTANT as keyof typeof mutations | undefined
if (selected && !mutations[selected]) throw Error('Unknown Focus group source inverse')
const sha = (code: string) => createHash('sha256').update(code).digest('hex')
let applied = false
export default defineConfig({ ...base, cacheDir: '.tmp/focus-group-discussion-cache', plugins: [...base.plugins ?? [], {
  name: 'actual-focus-group-task-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!), local = path.replace(/^apps\/desktop\/src\//, '')
    if (!path.startsWith('apps/desktop/src/')) return
    let code = original
    if (selected && local === mutations[selected][0]) {
      const [, before, after] = mutations[selected]
      if (code.split(before).length !== 2) throw Error('One exact actual group task source anchor required')
      code = code.replace(before, after); applied = true; process.stderr.write('MUTATION_APPLIED=' + selected + '\n')
    }
    if (process.env.AGENTMUX_FOCUS_GROUP_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_GROUP_LOADED,
      JSON.stringify({ path, original_sha256: sha(original), loaded_sha256: sha(code), mutant: code === original ? null : selected }) + '\n')
    return code === original ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The actual group source inverse was not consumed') }
}], test: { ...base.test, include: ['apps/desktop/test/focus-group-discussion.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
