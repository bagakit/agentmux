import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const proof = await mkdtemp(join(tmpdir(), 'goal-ticket-continuation-'))
const runs = [
  { id: 'baseline' },
  { id: 'drop-delivery', title: 'a real planned tick reaches Core', expected: 'a scheduled review names the precise original delivery',
    path: 'apps/host/src/continuous-progress-task-source.ts', anchor: "kind: 'review', delegationOperationId: attempt.operationId, deliveryHash",
    replacement: "kind: 'review', delegationOperationId: attempt.operationId" },
  { id: 'old-supervisor', title: 'a cold old loop checks the current plan Supervisor', expected: 'expected',
    path: 'apps/host/src/continuous-progress-loop-manager.ts',
    anchor: "source.action === 'continue' && goal?.plan && !loop.pendingCompletion && goal.supervisorSessionId !== loop.agentSessionId",
    replacement: 'false' },
  { id: 'restored' },
]
try {
  for (const { expected, title, ...change } of runs) {
    const loaded = join(proof, change.id)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'runner', '--no-cache', '--reporter=json',
        '--config', 'apps/desktop/test/vitest.goal-plan-continuation.config.mts', 'apps/desktop/test/goal-plan-continuation-product.test.ts',
        ...(title ? ['-t', title] : [])], {
        cwd: root, env: { ...process.env, GOAL_MANAGER_ROLE_MUTATION: expected ? JSON.stringify(change) : '', GOAL_MANAGER_ROLE_LOADED: loaded },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    })
    assert.equal(result.signal, null, result.stderr)
    let report
    try { report = JSON.parse(result.stdout) } catch (cause) { throw new Error(result.stderr + result.stdout, { cause }) }
    assert.ok(report.numTotalTests >= 10, result.stderr + result.stdout)
    const failures = report.testResults.flatMap(suite => suite.assertionResults).flatMap(test => test.failureMessages).join('\n')
    if (expected) {
      const source = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.ok(source.some(item => item.path === change.path && item.mutant === change.id && item.loadedSHA256 !== item.originalSHA256))
      assert.equal(result.code, 1, failures)
      assert.equal(report.numFailedTests, 1, failures)
      assert.ok(failures.includes(expected), failures)
    } else {
      assert.equal(result.code, 0, result.stderr + failures)
      assert.equal(report.numPassedTests, report.numTotalTests)
    }
    console.log(JSON.stringify({ id: change.id, result: expected ? 'mutation killed' : 'passed' }))
  }
} finally { await rm(proof, { recursive: true, force: true }) }
