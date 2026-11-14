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
if (baseline.status !== 0 || baseline.report.numPassedTests < 2) throw Error(JSON.stringify(baseline.report.testResults))
const mutant = run('reverse-child')
const killed = mutant.report.testResults.flatMap(file => file.assertionResults)
  .find(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('The child must follow the hovered task downstream.')))
if (mutant.status !== 1 || !killed) throw Error('Reversing the child link escaped the dependency-path assertion.')
console.log(`Mounted Desktop board: ${baseline.report.numPassedTests} tests passed. Reversing the saved child link failed “${killed.title}”.`)
