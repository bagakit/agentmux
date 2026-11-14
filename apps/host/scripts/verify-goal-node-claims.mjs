import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const proof = await mkdtemp(join(tmpdir(), 'amux-goal-node-claims-'))
const spec = 'apps/host/test/goal-node-claims.test.ts'
const runs = [
  { label: 'baseline' },
  { label: 'allow-related', failure: 'a related reader cannot claim an open node', source: 'apps/host/src/goal-plan-assignment.ts' },
  { label: 'lose-executor', failure: 'exactly one claim must be confirmed', source: 'packages/demand/src/demand-store.ts' },
  { label: 'restored' }
]
try {
  for (const { label, failure, source } of runs) {
    const file = join(proof, label + '.json'), witness = join(proof, label + '.loaded')
    const args = ['run', '--config', 'apps/host/test/vitest.goal-node-claims.config.mts',
      '--reporter=json', '--outputFile=' + file, spec]
    const result = await new Promise((accept, reject) => {
      const child = spawn(join(root, 'node_modules/.bin/vitest'), args, { cwd: root, env: { ...process.env, NODE_CLAIM_MUTATION: failure ? label : '', NODE_CLAIM_WITNESS: witness },
        stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''
      child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
      child.on('error', reject); child.on('close', (code, signal) => accept({ code, signal, log }))
    })
    assert.equal(result.signal, null, result.log)
    const report = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(report.numTotalTests, 1, result.log)
    const test = report.testResults.flatMap(entry => entry.assertionResults)
    assert.equal(test.length, 1, 'The CLI product consumer must run')
    if (failure) {
      assert.equal(await readFile(witness, 'utf8'), source)
      assert.equal(result.code, 1, result.log)
      assert.equal(report.numFailedTests, 1, result.log)
      assert.ok(test[0].failureMessages.some(message => message.includes(failure)), test[0].failureMessages.join('\n'))
    } else {
      assert.equal(result.code, 0, test[0].failureMessages.join('\n'))
      assert.equal(report.numPassedTests, 1, result.log)
    }
    console.log(JSON.stringify({ label, source, result: failure ? 'mutation killed' : 'passed' }))
  }
} finally { await rm(proof, { recursive: true, force: true }) }
