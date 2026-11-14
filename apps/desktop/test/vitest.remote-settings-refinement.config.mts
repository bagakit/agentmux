import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.remote-execution-settings.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_REMOTE_SETTINGS_EVIDENCE!
const mutant = process.env.REMOTE_REFINEMENT_MUTANT
const mutations: Record<string, [string, string, string]> = {
  'task-reader': ['components/settings/RemoteExecutionSettingsPane.tsx', "visible={active && task === 'existing' && detailVisible}", 'visible={active && detailVisible}'],
  'task-remount': ['components/settings/RemoteExecutionSettingsPane.tsx', '<AgentWorkModeSetup config=', '<AgentWorkModeSetup key={task} config='],
  'catalog-membership': ['components/settings/modules/mobile.tsx', "group: 'environment'", "group: 'agents'"],
  'field-task': ['components/settings/RemoteExecutionSettingsPane.tsx', "setTask(navigationRequest.field === 'bindings' ? 'existing' : 'start')", "setTask('start')"]
}
assert(!mutant || mutations[mutant], 'A declared source counterexample is required')
export default defineConfig({ ...original,
  plugins: [...(original.plugins ?? []), { name: 'remote-refinement-counterexample', enforce: 'pre', transform(code, id) {
    if (!mutant || !id.endsWith('/' + mutations[mutant]![0])) return
    const [, before, after] = mutations[mutant]!
    assert.equal(code.split(before).length - 1, 1, 'Counterexample must load one exact source anchor')
    const output = code.replace(before, after)
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(resolve(evidence, 'refinement-mutation.jsonl'), JSON.stringify({mutant, file: relative(root, id), original: sha(code), loaded: sha(output)}) + '\n')
    return {code: output, map: null}
  }}],
  test: { ...original.test, include: [
    'apps/desktop/test/remote-work-settings.test.tsx', 'apps/desktop/test/remote-execution-settings.test.tsx',
    'apps/desktop/test/settings-home.test.tsx', 'apps/desktop/test/settings-connections.test.tsx',
    'apps/desktop/test/settings-modules.test.tsx', 'apps/desktop/test/settings-work-groups.test.tsx'
  ], passWithNoTests: false, fileParallelism: false }
})
