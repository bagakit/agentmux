import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const title = 'signs original Tickets, claims and completions through the public CLI'
const claims = [
  { name: 'baseline' },
  { name: 'trust-altered-ticket', path: 'packages/demand/src/goal-ticket-crypto.ts', failure: 'recomputing the Ticket hash cannot authorize an altered author' },
  { name: 'omit-claim-completion', path: 'packages/demand/src/demand-store.ts', failure: 'claim proof must bind the actual upstream completion' },
  { name: 'restored' },
]
for (const { name, path, failure } of claims) {
  const run = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'runner', '--no-cache', '--reporter=json',
    '--config', 'apps/host/test/vitest.goal-node-claims.config.mts', 'apps/host/test/goal-ticket-journeys.test.ts', '-t', title], {
    cwd: root, env: { ...process.env, NODE_CLAIM_MUTATION: path ? name : '' }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  assert.equal(run.signal, null, run.stderr)
  if (run.error) throw run.error
  let result
  try { result = JSON.parse(run.stdout) } catch (error) { throw new Error('Missing Ticket proof test receipt: ' + run.stderr + run.stdout, { cause: error }) }
  const tests = result.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(tests.length, 1, JSON.stringify(result.testResults))
  const [test] = tests
  assert.equal(test.title, title)
  if (path) {
    assert.ok(run.stderr.includes('Goal claim mutation loaded: ' + path), run.stderr)
    assert.equal(run.status, 1)
    assert.equal(test.status, 'failed')
    assert.ok(test.failureMessages.some(message => message.includes(failure)), test.failureMessages.join('\n'))
  } else {
    assert.equal(run.status, 0, test.failureMessages.join('\n'))
    assert.equal(test.status, 'passed')
  }
  console.log(JSON.stringify({ name, result: path ? 'mutation killed' : 'passed' }))
}
