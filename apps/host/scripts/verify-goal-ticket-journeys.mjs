import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const result = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'runner', '--no-cache', '--reporter=json',
  '--config', 'apps/host/test/vitest.goal-node-claims.config.mts', 'apps/host/test/goal-ticket-journeys.test.ts',
  'apps/host/test/goal-node-claims.test.ts', '-t', 'uses the original Git result|claims independent successors'], { cwd: root, encoding: 'utf8' })
if (result.error) throw result.error
assert.equal(result.signal, null, result.stderr)
let report
try { report = JSON.parse(result.stdout) } catch (cause) { throw new Error(result.stderr + result.stdout, { cause }) }
const scenarios = report.testResults.flatMap(suite => suite.assertionResults)
assert.equal(result.status, 0, scenarios.flatMap(test => test.failureMessages).join('\n') + result.stderr)
assert.equal(scenarios.filter(test => test.status === 'passed').length, 2, result.stdout)
console.log(JSON.stringify({ file: 'passed', git: 'passed' }))
