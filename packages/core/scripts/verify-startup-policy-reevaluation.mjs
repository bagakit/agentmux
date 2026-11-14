import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mutations } from '../test/fixtures/startup-policy-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const directory = join(root, '.local/state/startup-policy-reevaluation')
await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'proof-'))
const owners = ['client', 'headless-runtime', 'hosted-runtime-service', 'public-rpc-service',
  'agent-session-recovery/supervisor', 'agent-session-recovery/continuity-attempt',
  'agent-session-recovery/continuity-policy', 'agent-session-recovery/continuity-activity'].map(name => 'packages/core/src/' + name + '.ts')
const paths = [...owners, 'packages/core/test/startup-policy-reevaluation.test.ts', 'packages/core/test/startup-policy-reevaluation.config.mts',
  ...['loader', 'mutations', 'owner', 'register'].map(name => 'packages/core/test/fixtures/startup-policy-' + name + '.mjs'),
  'packages/core/test/agent-session-continuity.test.ts', 'packages/core/test/agent-session-recovery-sources.test.ts',
  'packages/core/scripts/verify-startup-policy-reevaluation.mjs']
const hash = value => createHash('sha256').update(value).digest('hex')
const inputs = Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.startup-policy-reevaluation-proof.v1', passed: false, userRuntimeTouched: false,
  attempt, inputs, results: [] }
const rows = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const mutants = [
  ['retain-policy-decision', 'a fresh working startup', /AssertionError[\s\S]*recovery-supervised/u],
  ['skip-policy-admission-fence', 'concurrent cancelled at the admission CAS', /AssertionError/u],
  ['skip-policy-record-fence', 'concurrent cancel fences the fresh manual', /AssertionError/u],
  ['skip-policy-lifecycle-recheck', 'concurrent lifecycle-unavailable', /AssertionError/u],
  ['keep-policy-fence-after-commit', 'a healthy original frontend', /original policy decision changed before this startup was admitted/u]
]
try {
  for (const [name, pattern, expectedFailure] of [['candidate'], ['adjacent'], ...mutants]) {
    const mutant = Object.hasOwn(mutations, name) ? name : ''
    const report = join(attempt, name + '.json'), trace = join(attempt, name + '.sources.jsonl')
    const executions = join(attempt, name + '.owners.jsonl'), product = join(attempt, name + '.product.jsonl')
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/startup-policy-reevaluation.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report, ...(pattern ? ['--testNamePattern', pattern] : [])]
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, STARTUP_POLICY_MUTANT: mutant,
        STARTUP_POLICY_ADJACENT: name === 'adjacent' ? '1' : '', STARTUP_POLICY_TRACE: trace,
        STARTUP_POLICY_EXECUTIONS: executions, STARTUP_POLICY_PRODUCT: product }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
    })
    await writeFile(join(attempt, name + '.log'), result.output)
    const tests = JSON.parse(await readFile(report, 'utf8'))
    const assertions = tests.testResults.flatMap(file => file.assertionResults)
    const failed = assertions.filter(test => test.status === 'failed')
    const selected = assertions.filter(test => !['pending', 'skipped', 'todo'].includes(test.status))
    assert.equal(result.signal, null, 'The test process must exit naturally')
    assert.equal(assertions.length, name === 'adjacent' ? 91 : 36, 'Exact nonempty test inventory')
    if (mutant) {
      assert.equal(selected.length, 1, 'One exact consumer must execute for the causal mutation')
      assert.equal(result.code, 1); assert.equal(failed.length, 1)
      assert.ok(failed[0].fullName.includes(pattern))
      assert.ok(failed[0].failureMessages.some(message => expectedFailure.test(message)), failed[0].failureMessages.join('\n'))
      const source = await rows(trace), pids = new Set((await rows(executions)).map(value => value.pid))
      assert.ok(source.some(value => pids.has(value.pid) && value.file === mutations[mutant].file && !value.legacy &&
        value.mutation === mutant && value.originalSHA256 === inputs[value.file] && value.loadedSHA256 !== value.originalSHA256),
      'The actual product owner must evaluate the changed source')
    } else {
      assert.equal(result.code, 0, result.output); assert.equal(failed.length, 0)
      assert.equal(selected.length, assertions.length); assert.equal(tests.numPassedTests, assertions.length)
      if (name === 'candidate') {
        const source = await rows(trace), products = await rows(product)
        assert.deepEqual(products.map(value => value.state).sort(), ['done', 'working'])
        for (const actual of products) {
          assert.notEqual(actual.originalRun, actual.resumedRun); assert.equal(actual.actualNativeLaunches, 2)
          assert.equal(actual.originalPromptCount, 1); assert.equal(actual.preservedLegacyJournal, true)
          assert.equal(actual.originalContextInputAcknowledged, true)
          for (const file of owners) assert.ok(source.some(value => value.file === file && value.pid === actual.ownerPid &&
            !value.legacy && value.mutation === null && value.originalSHA256 === inputs[file] && value.loadedSHA256 === inputs[file]),
          'Exact current source must reach the consuming owner: ' + file)
        }
        receipt.product = products
      }
    }
    receipt.results.push({ name, code: result.code, passed: tests.numPassedTests, failed: tests.numFailedTests,
      selected: selected.length, failures: failed.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    process.stdout.write(name + ': ' + (mutant ? 'consumer RED' : 'GREEN') + '\n')
  }
  for (const [path, before] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, path))), before, 'Candidate changed: ' + path)
  receipt.passed = true
} catch (error) { receipt.error = error.stack ?? String(error); throw error }
finally {
  await writeFile(join(attempt, 'proof.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(directory, 'proof.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write('Retained startup policy evidence: ' + attempt + '\n')
}
