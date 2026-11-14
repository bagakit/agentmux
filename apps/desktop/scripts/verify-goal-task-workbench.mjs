import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
for (const [script, ...args] of [
  ['verify-goal-plan-path.mjs'],
  ['verify-goals-surface.mjs', '--goal-task-workbench-only', '--evidence', resolve(root, '.tmp/goal-task-workbench')]
]) {
  execFileSync(process.execPath, [resolve(import.meta.dirname, script), ...args], { cwd: root, stdio: 'inherit' })
}
