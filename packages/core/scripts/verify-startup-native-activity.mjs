import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const directory = join(root, '.local/state/startup-native-activity')
await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'proof-'))
const paths = ['packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/agent-session-recovery/continuity-policy.ts',
  'packages/core/src/client.ts', 'packages/core/test/startup-native-activity.test.ts', 'packages/core/test/startup-native-activity.config.mts',
  'packages/core/scripts/verify-startup-native-activity.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.startup-native-activity-proof.v1', passed: false, userRuntimeTouched: false, inputs, results: [] }
try {
  for (const mutant of [false, true]) {
    const name = mutant ? 'projection-admission' : 'candidate', report = join(attempt, name + '.json')
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/startup-native-activity.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root,
        env: { ...process.env, AGENTMUX_TEST_STARTUP_ACTIVITY_MUTANT: mutant ? name : '' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
    })
    await writeFile(join(attempt, name + '.log'), result.output)
    const tests = JSON.parse(await readFile(report, 'utf8'))
    const assertions = tests.testResults.flatMap(file => file.assertionResults), failed = assertions.filter(test => test.status === 'failed')
    assert.equal(assertions.length, 3, 'Exact nonempty restart test inventory')
    if (mutant) {
      assert.equal(result.code, 1); assert.equal(result.signal, null)
      assert.equal(failed.length, 2); assert.equal(tests.numPassedTests, 1)
      assert.ok(failed.every(test => test.failureMessages.some(message => /AssertionError/su.test(message) && /not-active/su.test(message))),
        'The loaded original projection must fail the actual automatic admission assertions')
    } else { assert.equal(result.code, 0, result.output); assert.equal(tests.numPassedTests, 3) }
    receipt.results.push({ name, code: result.code, passed: tests.numPassedTests, failed: tests.numFailedTests,
      loadedMutation: mutant ? 'continuity-attempt.ts automatic admission consumes projectSession(current)' : null,
      failures: failed.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    process.stdout.write(name + ': ' + (mutant ? 'assertion RED' : 'GREEN') + '\n')
  }
  for (const [path, before] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, path))), before, 'Candidate source changed: ' + path)
  receipt.passed = true
} catch (error) { receipt.error = error.message; throw error }
finally {
  await writeFile(join(directory, 'proof.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.passed) await rm(attempt, { recursive: true, force: true })
  else process.stderr.write('Retained failed qualification: ' + attempt + '\n')
}
