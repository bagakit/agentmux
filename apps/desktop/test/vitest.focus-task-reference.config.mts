import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import base from './vitest.focus-read-projection.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutants = {
  'ignore-canonical-project': ['lib/focus-group-reference.ts', "if (lane.projectSpaceId) return { kind: 'project', hostId: lane.hostId, projectSpaceId: lane.projectSpaceId }", ''],
  'drop-main-reference': ['lib/mote-task-handoff.ts', '...(task.focusTask ? { focusTask: task.focusTask } : {})', ''],
  'drop-launcher-reference': ['components/FocusGroupDiscussion.tsx', 'openFocusGroupAgentLauncher(project, prompt, current, focusTask)', 'openFocusGroupAgentLauncher(project, prompt, current)'],
  'prompt-only-receipt': ['components/FocusGroupDiscussion.tsx', 'moteTaskPacketKey(prompt, focusTask)', 'prompt']
} as const
const selected = process.env.AGENTMUX_FOCUS_TASK_REFERENCE_MUTANT as keyof typeof mutants | undefined
if (selected && !mutants[selected]) throw Error('Unknown reference-first task inverse')
let applied = false
export default defineConfig({ ...base, cacheDir: '.tmp/focus-task-reference-cache', plugins: [{ name: 'actual-focus-task-reference-source', enforce: 'pre', transform(code, id) {
  if (!selected || relative(root, id.split('?')[0]!) !== 'apps/desktop/src/renderer/src/' + mutants[selected][0]) return
  const [, before, after] = mutants[selected]
  const count = code.split(before).length - 1
  if (count !== (selected === 'prompt-only-receipt' ? 2 : 1)) throw Error('Exact reference-first source anchors required')
  applied = true; process.stderr.write('MUTATION_APPLIED=' + selected + '\n')
  return { code: code.replaceAll(before, after), map: null }
}, buildEnd() { if (selected && !applied) throw Error('Actual reference-first source inverse not consumed') } }],
test: { ...base.test, include: ['apps/desktop/test/focus-task-packet.test.tsx', 'apps/desktop/test/focus-group-discussion.test.tsx'], passWithNoTests: false } })
