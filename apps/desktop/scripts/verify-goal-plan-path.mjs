import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const config = 'apps/desktop/test/vitest.goal-plan-path.config.mts'
function run(mutation) {
  const result = spawnSync('node_modules/.bin/vitest', ['run', '--config', config, '--reporter=json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GOAL_PLAN_PATH_MUTATION: mutation ?? '' }, maxBuffer: 8 * 1024 * 1024
  })
  if (result.error) throw result.error
  try {
    return { status: result.status, report: JSON.parse(result.stdout) }
  } catch (cause) {
    throw Error(result.stdout + result.stderr, { cause })
  }
}
const baseline = run()
if (baseline.status !== 0 || baseline.report.numPassedTests < 3) throw Error(JSON.stringify(baseline.report.testResults))
for (const [mutation, assertion] of [
  ['collapse-ports', 'Parallel dependencies need distinct ports on their shared task.'],
  ['reverse-child', 'The child must follow the hovered task downstream.'],
  ['wrong-reader', 'The reading pane belongs to the selected task.']
]) {
  const mutant = run(mutation)
  const killed = mutant.report.testResults.flatMap(file => file.assertionResults)
    .find(test => test.status === 'failed' && test.failureMessages.some(message => message.includes(assertion)))
  if (mutant.status !== 1 || !killed) throw Error(mutation + ' escaped its workbench assertion.')
  console.log(mutation + ' failed the mounted Desktop assertion: ' + assertion)
}
console.log(baseline.report.numPassedTests + ' mounted Desktop board tests passed on the original source.')
