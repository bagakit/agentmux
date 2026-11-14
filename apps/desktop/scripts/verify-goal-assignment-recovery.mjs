import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const proof = mkdtempSync(join(tmpdir(), 'amx-assignment-recovery-'))
const spec = 'apps/desktop/test/goal-plan-assignment-workbench.test.tsx'
const mutations = [
  ['keep-unsent', 'restores the selected executor', 'A known-unsent choice must be editable'],
  ['discard-unknown', 'preserves the original unknown', 'A failed retry must keep the earlier unknown operation'],
  ['discard-newer-attempt', 'keeps the remounted retry', 'A late completion cannot remove the remounted request']
]
try {
  for (const [label, selected, failure] of [['baseline'], ...mutations, ['restored']]) {
    const report = join(proof, label + '.json'), witness = join(proof, label + '.loaded')
    const args = ['run', '--config', 'apps/desktop/test/vitest.goal-plan-assignment.config.mts', spec,
      '--reporter=json', '--outputFile=' + report, ...(selected ? ['-t', selected] : [])]
    const run = spawnSync('node_modules/.bin/vitest', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GOAL_ASSIGNMENT_MUTATION: selected ? label : '', GOAL_ASSIGNMENT_RECOVERY_WITNESS: witness } })
    assert.equal(run.signal, null, run.stderr)
    const data = JSON.parse(readFileSync(report, 'utf8'))
    const tests = data.testResults.flatMap(file => file.assertionResults)
    if (selected) {
      const test = tests.find(result => result.title.includes(selected))
      assert.equal(run.status, 1, run.stderr)
      assert.equal(data.numFailedTests, 1)
      assert.equal(test?.status, 'failed')
      assert.ok(test.failureMessages.some(message => message.includes(failure)), test.failureMessages.join('\n'))
      assert.equal(readFileSync(witness, 'utf8'), label)
    } else {
      assert.equal(run.status, 0, tests.flatMap(result => result.failureMessages).join('\n') || run.stderr)
      assert.ok(mutations.every(([, expected]) => tests.some(test => test.title.includes(expected) && test.status === 'passed')))
    }
    console.log(JSON.stringify({ label, passed: data.numPassedTests, failed: data.numFailedTests }))
  }
} finally { rmSync(proof, { recursive: true, force: true }) }
