import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, planChecks, validateEvidence, runChild, runChecks } from '../scripts/verify-cross-host-execution.mjs'

test('the planned Tracker command selects the exact four existing checks in order', () => {
  assert.deepEqual(parseArgs(['--mutations', '--plan']), { mutations: true, plan: true, output: undefined })
  const checks = planChecks('/private-evidence', true)
  assert.deepEqual(checks.map(item => item.id), ['baseline', 'mutations', 'native-ipc', 'visual-capture-and-restart'])
  assert.deepEqual(checks[1].args, ['apps/desktop/scripts/verify-tool-execution-ui-mutants.mjs', '/private-evidence/mutations'])
  assert.deepEqual(checks[2].args, ['apps/desktop/scripts/verify-space-agent-cli.mjs', '/private-evidence/native-ipc', '--tool-workspace'])
  assert.deepEqual(checks[3].args, ['apps/desktop/scripts/capture-tool-execution-ui.mjs', '/private-evidence/visual'])
  assert(checks[0].args.includes('--reporter=json'))
  assert.equal(planChecks('/private-evidence', false).length, 3)
  for (const args of [['--unknown'], ['--mutations', '--mutations'], ['--output'], ['--output', '--plan']]) assert.throws(() => parseArgs(args))
})
test('empty baseline, omitted mutation, unhit mutation and fake capture cannot pass', () => {
  assert.throws(() => validateEvidence('baseline', { success: true, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0 }))
  assert.throws(() => validateEvidence('mutations', []))
  const mutations = ['tool-target', 'local-host-inventory', 'notices', 'initial-order', 'reader-isolation'].map(mutation => ({ mutation, killed: true, exitCode: 1 }))
  validateEvidence('mutations', mutations)
  assert.throws(() => validateEvidence('mutations', mutations.map((item, index) => index ? item : { ...item, killed: false })))
  assert.throws(() => validateEvidence('visual-capture-and-restart', { passed: true, captureOnly: true, frames: [] }))
  assert.throws(() => validateEvidence('native-ipc', { passed: true, phases: [] }))
})
test('a real failing child exit rejects', async () => {
  await assert.rejects(runChild({ id: 'private-exit-check', executable: process.execPath, args: ['-e', 'process.exit(7)'] }), /exit=7/)
})
test('dispatch stays sequential, failures stop later work, and passing checks never sign visual review', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-entry-'))
  try {
    const evidence = join(directory, 'baseline.json'), report = join(directory, 'report.json')
    const check = { id: 'baseline', executable: 'not-run', args: [], evidence }
    await assert.rejects(runChecks([], report), /No verification checks/)
    await writeFile(evidence, JSON.stringify({ success: true, numTotalTests: 13, numPassedTests: 13, numFailedTests: 0 }))
    let running = false; const order = []
    const result = await runChecks([check, { ...check, ordinal: 2 }], report, async item => { assert.equal(running, false); running = true; order.push(item.ordinal ?? 1); await Promise.resolve(); running = false })
    assert.deepEqual(order, [1, 2]); assert.equal(result.checksPassed, true); assert.equal(result.independentVisualReview.status, 'pending')
    const calls = []
    await assert.rejects(runChecks([check, { ...check, ordinal: 2 }], report, async item => { calls.push(item); throw new Error('original child failed') }), /original child failed/)
    assert.equal(calls.length, 1)
    const failed = JSON.parse(await readFile(report, 'utf8'))
    assert.equal(failed.checksPassed, false); assert.deepEqual(failed.checks.map(item => item.status), ['failed', 'pending'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
