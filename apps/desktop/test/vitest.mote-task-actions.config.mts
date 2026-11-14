import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.focus-project-appearance.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'shared-action-receipt': ['components/MoteTaskAction.tsx', 'JSON.stringify([ownerKey, action.id])', 'JSON.stringify([ownerKey])'],
  'late-mote-admission': ['components/MoteTaskAction.tsx', 'rootPath }, create, current, () =>', 'rootPath }, create, () => true, () =>'],
  'late-new-agent': ['components/MoteTaskAction.tsx', 'if (!current()) return', 'if (false) return'],
  'detached-chooser': ['components/MoteTaskAction.tsx', '{...(portalContainer ? { menuContainer: portalContainer } : {})}', ''],
  'new-agent-as-mote': ['components/MoteActionChooser.tsx', 'onSelect={newAgent.onSelect}', 'onSelect={() => onSelect(newAgent.key)}']
} as const
const selected = process.env.AGENTMUX_MOTE_TASK_MUTANT as keyof typeof mutations | undefined
if (selected && !mutations[selected]) throw Error('Unknown shared Mote task mutation')
const hash = (code: string) => createHash('sha256').update(code).digest('hex')
let applied = false
export default defineConfig({ ...base, cacheDir: '.tmp/mote-task-actions-cache', plugins: [...base.plugins ?? [], {
  name: 'actual-shared-mote-task', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    let code = source
    if (selected && path === 'apps/desktop/src/renderer/src/' + mutations[selected][0]) {
      const [, before, after] = mutations[selected]
      if (code.split(before).length !== 2) throw Error('One exact shared Mote task source anchor required')
      code = code.replace(before, after); applied = true; process.stderr.write('MUTATION_APPLIED=' + selected + '\n')
    }
    if (process.env.AGENTMUX_MOTE_TASK_LOADED && path.startsWith('apps/desktop/src/')) appendFileSync(process.env.AGENTMUX_MOTE_TASK_LOADED,
      JSON.stringify({ path, original_sha256: hash(source), loaded_sha256: hash(code), mutant: source === code ? null : selected }) + '\n')
    return code === source ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('Shared Mote task source mutation was not consumed') }
}], test: { ...base.test, include: selected ? ['apps/desktop/test/mote-task-actions.test.tsx']
  : ['apps/desktop/test/mote-task-actions.test.tsx', 'apps/desktop/test/tailcat-mote-assistance.test.tsx', 'apps/desktop/test/launcher-mote-create.test.tsx'],
  maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
