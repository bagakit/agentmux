import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.focus-project-appearance.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'wrong-space-address': ['formatSpaceAddress({ spaceId: folderSpaceFacts(current).space.spaceId })', 'formatSpaceAddress({ spaceId: folderSpaceFacts(useAppStore.getState().config!.workspaces.find(item => item.id === useAppStore.getState().activeWorkspaceId)!).space.spaceId })'],
  'wrong-space-project': ['selectWorkspace(current.id)', 'selectWorkspace(useAppStore.getState().activeWorkspaceId!)']
} as const
const selected = process.env.AGENTMUX_FOCUS_PROJECT_ACTION_MUTANT as keyof typeof mutations | undefined
if (selected && !mutations[selected]) throw Error('Unknown project action source mutation')
const hash = (code: string) => createHash('sha256').update(code).digest('hex')
let applied = false
export default defineConfig({ ...base, cacheDir: '.tmp/focus-project-actions-cache', plugins: [...base.plugins ?? [], {
  name: 'actual-focus-project-actions-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    let code = source
    if (selected && path === 'apps/desktop/src/renderer/src/components/FocusProjectActions.tsx') {
      const [before, after] = mutations[selected]
      if (code.split(before).length !== 2) throw Error('One exact project action source anchor required')
      code = code.replace(before, after); applied = true; process.stderr.write('MUTATION_APPLIED=' + selected + '\n')
    }
    if (process.env.AGENTMUX_FOCUS_PROJECT_ACTION_LOADED && path.startsWith('apps/desktop/src/')) appendFileSync(process.env.AGENTMUX_FOCUS_PROJECT_ACTION_LOADED,
      JSON.stringify({ path, original_sha256: hash(source), loaded_sha256: hash(code), mutant: code === source ? null : selected }) + '\n')
    return code === source ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('Actual project action source mutation was not consumed') }
}], test: { ...base.test, include: ['apps/desktop/test/focus-project-actions.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
