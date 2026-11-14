import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const cwd = resolve(import.meta.dirname, '../../..')
const common = ['run', '--config', 'apps/desktop/test/vitest.goals-workflow-filter.config.mts']
function check(args, mutation = '') {
  const run = spawnSync(resolve(cwd, 'node_modules/.bin/vitest'), [...common, ...args], {
    cwd, env: { ...process.env, GOALS_WORKFLOW_MUTATION: mutation, NO_COLOR: '1' }, encoding: 'utf8',
    timeout: 120000, maxBuffer: 8 * 1024 * 1024
  })
  if (run.error) throw run.error
  return { status: run.status, output: run.stdout + run.stderr }
}
const original = check([])
assert.equal(original.status, 0, original.output)
assert.match(original.output, /4 passed/)
const name = 'filters the actual board lanes by workflow'
const mutant = check(['-t', name], 'ignore-stage')
assert.equal(mutant.status, 1, mutant.output)
assert.match(mutant.output, /AssertionError/, mutant.output)
assert.match(mutant.output, /1 failed/, mutant.output)
assert.ok(mutant.output.includes(name) && mutant.output.includes('ui'), mutant.output)
console.log('Four product filtering tests passed. Ignoring the selected workflow in the actual board lanes failed the original row-identity assertion.')
