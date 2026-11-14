import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../..', import.meta.url))
const args = ['run', '--config', 'apps/desktop/test/vitest.goal-plan-assignment.config.mts']
const run = (extra = [], env = {}) => spawnSync('node_modules/.bin/vitest', [...args, ...extra], {
  cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024
})
const baseline = run()
if (baseline.status !== 0) throw Error(baseline.stderr + baseline.stdout)
console.log(baseline.stdout)
const mutation = run(['-t', 'opens, closes and assigns'], { GOAL_ASSIGNMENT_MUTATION: 'wrong-node' })
if (mutation.status !== 1 || !mutation.stderr.includes('AssertionError') || !mutation.stdout.includes('1 failed'))
  throw Error('Wrong-node mutation was not killed by its behavior assertion.\n' + mutation.stdout + mutation.stderr)
console.log('Changing the addressed node failed the board-to-owner assignment assertion.')
