import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const spec = 'apps/host/test/goal-node-claims.test.ts'
const independentTitle = 'claims independent successors'
const deliveryProof = process.argv[2] === '--delivery'
const runs = deliveryProof ? [
  { label: 'baseline', title: independentTitle },
  { label: 'skip-delivery-review-match', title: independentTitle, failure: 'an independent review must bind the exact delivery hash', source: 'packages/demand/src/demand-store.ts' },
  { label: 'omit-delivery-author', title: independentTitle, failure: 'the delivery hash binds the original author and report contents', source: 'packages/demand/src/demand-store.ts' },
  { label: 'omit-delivery-report', title: independentTitle, failure: 'the delivery hash binds the original author and report contents', source: 'packages/demand/src/demand-store.ts' },
  { label: 'restored', title: independentTitle },
] : [
  { label: 'baseline' },
  { label: 'allow-related', title: 'saves one authorized claimant', failure: 'a related reader cannot claim an open node', source: 'apps/host/src/goal-plan-assignment.ts' },
  { label: 'lose-executor', title: 'saves one authorized claimant', failure: 'exactly one claim must be confirmed', source: 'packages/demand/src/demand-store.ts' },
  { label: 'wrong-goal-token', title: 'saves one authorized claimant', failure: 'a claim cannot use another Goal’s token', source: 'packages/demand/src/goal-plan.ts' },
  { label: 'restore-old-token', title: 'saves one authorized claimant', failure: 'a reversed check revision does not revive the original claim', source: 'packages/demand/src/goal-plan.ts' },
  { label: 'whole-plan-token', title: 'claims independent successors', failure: 'independent claims must succeed from the same read', source: 'packages/demand/src/goal-plan.ts' },
  { label: 'drop-predecessors', title: 'claims independent successors', failure: 'The original Core source names different predecessor receipts', source: 'packages/core/src/goal-delegation-source.ts' },
  { label: 'stale-first-dispatch', title: 'claims independent successors', failure: 'a prepared attempt requires current predecessor receipts at first dispatch', source: 'packages/demand/src/demand-store.ts' },
  { label: 'restored' }
]
for (const { label, failure, source, title } of runs) {
  const args = ['run', '--configLoader', 'runner', '--config', 'apps/host/test/vitest.goal-node-claims.config.mts',
    '--reporter=json', '--no-cache', spec, ...(title ? ['-t', title] : [])]
  const result = await new Promise((accept, reject) => {
    const child = spawn(join(root, 'node_modules/.bin/vitest'), args, { cwd: root, env: { ...process.env, NODE_CLAIM_MUTATION: failure ? label : '' },
      stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.on('error', reject); child.on('close', (code, signal) => accept({ code, signal, stdout, stderr }))
  })
  assert.equal(result.signal, null, result.stderr)
  let report
  try { report = JSON.parse(result.stdout) }
  catch (cause) { throw new Error('No test receipt for ' + label + '\n' + result.stderr + result.stdout, { cause }) }
  const diagnostic = result.stderr + '\n' + report.testResults.map(entry => entry.message).filter(Boolean).join('\n')
  assert.equal(report.numTotalTests, 2, diagnostic)
  const test = report.testResults.flatMap(entry => entry.assertionResults)
  assert.equal(test.length, 2, 'The CLI product consumer must run')
  if (failure) {
    assert.ok(result.stderr.includes('Goal claim mutation loaded: ' + source + '\n'), diagnostic)
    assert.equal(result.code, 1, diagnostic)
    assert.equal(report.numFailedTests, 1, diagnostic)
    assert.ok(test.flatMap(assertion => assertion.failureMessages).some(message => message.includes(failure)), test.flatMap(assertion => assertion.failureMessages).join('\n'))
  } else {
    assert.equal(result.code, 0, test.flatMap(assertion => assertion.failureMessages).join('\n'))
    assert.equal(report.numPassedTests, title ? 1 : 2, diagnostic)
  }
  console.log(JSON.stringify({ label, source, result: failure ? 'mutation killed' : 'passed' }))
}
