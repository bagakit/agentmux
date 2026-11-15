import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
for (const phase of ['baseline', 'active-full-snapshot', 'restored']) {
  const mutation = phase === 'active-full-snapshot'
  const result = await new Promise((resolve, reject) => {
    const child = spawn(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'runner', '--no-cache', '--reporter=json',
      '--config', 'apps/host/test/vitest.goal-node-claims.config.mts', 'apps/host/test/goal-active-cost.test.ts'], {
      cwd: root, env: { ...process.env, NODE_CLAIM_MUTATION: mutation ? phase : '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  assert.equal(result.signal, null, result.stderr)
  let report
  try { report = JSON.parse(result.stdout) } catch (cause) { throw new Error(result.stderr + result.stdout, { cause }) }
  const tests = report.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(tests.length, 1, result.stderr + result.stdout)
  const failure = tests[0].failureMessages.join('\n')
  if (mutation) {
    assert.ok(result.stderr.includes('Goal claim mutation loaded: packages/demand/src/demand-store.ts'))
    assert.equal(result.code, 1, failure)
    assert.ok(failure.includes('active reads must skip the original full snapshot'), failure)
  } else {
    assert.equal(result.code, 0, result.stderr + failure)
    assert.equal(tests[0].status, 'passed', failure)
  }
  console.log(JSON.stringify({ phase, result: mutation ? 'mutation killed' : 'passed' }))
}
