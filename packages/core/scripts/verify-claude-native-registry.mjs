import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/claude-native-registry-qualification')
const config = 'packages/core/test/vitest.claude-native-registry.config.mts'
const test = 'packages/core/test/claude-native-registry.test.ts'
const cases = [
  ['skip-registry', 'confirms the same native process without an open transcript and ignores mutable display metadata', /AssertionError/u],
  ['ignore-session', 'rejects a changed registered sessionId even when the retained locator exists', /promise resolved.*instead of rejecting/su],
  ['ignore-pid', 'rejects a changed registered pid even when the retained locator exists', /promise resolved.*instead of rejecting/su],
  ['ignore-start', 'rejects a changed registered procStart even when the retained locator exists', /promise resolved.*instead of rejecting/su],
  ['skip-refresh-hint', 'public source refresh clears unknown and the same registered Provider witness permits exactly one fork', /No current main native Session was confirmed/u],
  ['skip-fork-hint', 'public source refresh clears unknown and the same registered Provider witness permits exactly one fork', /The fork source has no confirmed current native witness/u]
]

/** A failed process/suite is not a killed mutation: the exact assertion must run. */
function qualifiedFailure(report, title, expected) {
  assert.ok(report.numTotalTests > 0, 'No executed test collection')
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0, 'Runtime/collection failure is not mutation proof')
  assert.ok(report.testResults.length > 0, 'Missing actual test files')
  for (const file of report.testResults) {
    assert.ok(file.assertionResults.length > 0, 'A suite failed before its assertions ran')
    assert.ok(!file.message, 'Suite collection failed')
  }
  const failed = report.testResults.flatMap(file => file.assertionResults).filter(item => item.status === 'failed')
  assert.ok(failed.length > 0, 'No actual failing test')
  const messages = failed.flatMap(item => item.failureMessages).join('\n')
  assert.doesNotMatch(messages, /ENOSPC|EDQUOT|EMFILE|ENFILE|Timed out|timeout|Cannot find module|Failed to (?:load|resolve)/iu,
    'Environment failure is not mutation proof')
  assert.ok(failed.some(item => item.title === title && item.failureMessages.some(message => expected.test(message))),
    'Expected production counterexample did not fail')
  return failed.map(item => item.fullName)
}

// Prove the classifier rejects the failure modes that previously faked a kill.
const sample = { numTotalTests: 1, testResults: [{ message: '', assertionResults: [
  { title: 'expected case', fullName: 'expected case', status: 'failed', failureMessages: ['AssertionError: expected true'] }
] }] }
assert.deepEqual(qualifiedFailure(sample, 'expected case', /AssertionError/u), ['expected case'])
assert.throws(() => qualifiedFailure({ ...sample, numTotalTests: 0 }, 'expected case', /AssertionError/u))
assert.throws(() => qualifiedFailure({ ...sample, testResults: [{ message: 'ENOSPC', assertionResults: [] }] }, 'expected case', /AssertionError/u))
for (const message of ['ENOSPC: no space left on device', 'Test timed out in 20000ms']) {
  assert.throws(() => qualifiedFailure({ ...sample, testResults: [{ message: '', assertionResults: [
    { ...sample.testResults[0].assertionResults[0], failureMessages: [message] }
  ] }] }, 'expected case', /./u))
}

const sources = ['packages/core/src/client.ts', 'packages/core/src/agent-native-process-linux.ts',
  'packages/core/src/agent-native-session-capture.ts', 'packages/core/src/types.ts',
  'packages/core/src/providers/claude-native-sources.ts', 'packages/providers/src/claude/native-session.ts', 'packages/providers/src/claude/native-registry.ts', test, config,
  'packages/core/scripts/verify-claude-native-registry.mjs']
const fingerprint = async () => Object.fromEntries(await Promise.all(sources.map(async file =>
  [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
const before = await fingerprint()
await mkdir(evidence, { recursive: true })
await rm(join(evidence, 'qualification.json'), { force: true })
async function run(label, mutation) {
  const reportPath = join(evidence, label + '.json')
  await rm(reportPath, { force: true })
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
    ...(mutation ? [test] : []), '--reporter=json', '--outputFile', reportPath], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, AMX_CLAUDE_REGISTRY_MUTATION: mutation?.[0] ?? '' }
  })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  await writeFile(join(evidence, label + '.log'), output)
  assert.ifError(result.error)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  if (!mutation) {
    assert.equal(result.status, 0, output)
    assert.ok(report.numPassedTests > 0)
    assert.equal(report.numFailedTests, 0)
    assert.equal(report.success, true)
    return { tests: report.numPassedTests }
  }
  assert.notEqual(result.status, 0, 'Mutation unexpectedly passed')
  assert.ok(output.includes('CLAUDE_REGISTRY_MUTANT_HIT ' + mutation[0]), 'Mutation did not load')
  return { name: mutation[0], failedTests: qualifiedFailure(report, mutation[1], mutation[2]) }
}
const baseline = await run('baseline')
const mutations = []
for (const item of cases) {
  mutations.push(await run(item[0], item))
  console.log(item[0] + ': expected test failure confirmed')
}
const restored = await run('restored')
assert.deepEqual(await fingerprint(), before, 'Candidate changed during qualification')
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ passed: true, sources: before, baseline, mutations, restored,
  boundary: 'Source Provider, Core, Hosted SDK, public RPC and CLI regressions; no installed Core upgrade or user-session fork.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, evidence, baseline, restored, mutations: mutations.length }))
