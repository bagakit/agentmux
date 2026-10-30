import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { goalOwnerRecoveryMutations, goalOwnerRecoverySources, prepareGoalOwnerIdentity } from '../test/goal-owner-recovery-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const directory = resolve(root, '.local/state/mobile-independent-host/review-remediation/goal-owner-recovery')
await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(resolve(directory, 'attempt-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const harness = ['apps/host/scripts/verify-goal-owner-recovery.mjs', 'apps/host/test/goal-owner-recovery-mutations.mjs',
  'packages/core/test/helpers/workspace-source-export.mjs',
  'packages/core/test/helpers/private-node-source-bundle.mjs',
  'apps/host/test/vitest.goal-owner-recovery.config.mts', 'apps/host/test/vitest.goals-domain.config.mts',
  'apps/host/test/vitest.mobile-goals.config.mts', 'apps/host/test/vitest.mobile-discovery.config.mts',
  'packages/identity/scripts/runtime-bundle.mjs', 'packages/identity/src/runtime-entry.ts',
  ...['core', 'identity', 'demand', 'capsule', 'diagnostic-evidence', 'connectors', 'client-ui', 'relay', 'git', 'native-desktop'].map(name => `packages/${name}/package.json`), 'apps/host/package.json']
const paths = [...new Set([...goalOwnerRecoverySources, ...harness])]
const receipt = { schema: 'agentmux.goal-owner-recovery.v1', passed: false, attempt: relative(root, attempt),
  scope: 'Current source public RPC → createHostGoals → actual Manager and durable file Store, with independent bundled source Store process reopen. Actual Demand file mutations, scoped observer indices, synchronous cancellation and external shared-file revision-gap resync. Runtime observations and Native submission are explicit controlled ports; no installed App, Native CLI, transport or user Runtime claim.',
  conditions: { node: process.version, platform: process.platform, arch: process.arch }, inputs: {}, runs: [] }
const save = () => writeFile(resolve(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await save()
process.stdout.write(JSON.stringify({ state: 'started', attempt: receipt.attempt }) + '\n')
try {
  await prepareGoalOwnerIdentity(root)
  const inputs = Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(resolve(root, path)))])))
  receipt.inputs = inputs
  await save()
  const checkInputs = async () => {
    for (const [path, expected] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, path))), expected, 'This proof input changed: ' + path)
  }
  const readLines = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const runs = receipt.runs
  let originalCases
  for (const label of ['baseline', ...Object.keys(goalOwnerRecoveryMutations), 'restored']) {
    await checkInputs()
    const mutation = goalOwnerRecoveryMutations[label]
    const loaded = resolve(attempt, label + '-loaded.jsonl'), facts = resolve(attempt, label + '-facts.jsonl'), result = resolve(attempt, label + '-result.json')
    await Promise.all([writeFile(loaded, ''), writeFile(facts, '')])
    receipt.current = { label, state: 'running', loaded: relative(root, loaded), facts: relative(root, facts), result: relative(root, result) }
    await save()
    const args = ['exec', 'vitest', 'run', '--config', 'apps/host/test/vitest.goal-owner-recovery.config.mts', '--reporter=json', '--outputFile=' + result]
    if (mutation) args.push('--testNamePattern', mutation.pattern)
    const run = await new Promise((accept, reject) => {
      const child = spawn('pnpm', args, { cwd: root, env: { ...process.env, AGENTMUX_GOAL_OWNER_RECOVERY_MUTANT: mutation ? label : '',
        AGENTMUX_GOAL_OWNER_RECOVERY_LOADED: loaded, AGENTMUX_GOAL_OWNER_RECOVERY_FACTS: facts }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
    })
    await writeFile(resolve(attempt, label + '.log'), run.output)
    receipt.current = { ...receipt.current, state: 'process-completed', exitCode: run.code, signal: run.signal }
    await save()
    const report = JSON.parse(await readFile(result, 'utf8'))
    const assertions = report.testResults.flatMap(suite => suite.assertionResults)
    const cases = assertions.filter(test => test.status !== 'pending' && test.status !== 'skipped' && test.status !== 'todo')
    const failures = cases.filter(test => test.status === 'failed')
    const evaluations = await readLines(loaded), observations = await readLines(facts)
    const evidence = { label, exitCode: run.code, signal: run.signal, collected: assertions.length, executed: cases.length,
      passed: cases.length - failures.length, failed: failures.length, validated: false,
      failures: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })), observations,
      evaluations: [...new Map(evaluations.map(row => [JSON.stringify(row), row])).values()], resultSHA256: hash(await readFile(result)) }
    runs.push(evidence)
    await save()
    assert.equal(run.signal, null, 'A source consumer process must finish normally: ' + label)
    assert.equal(assertions.length, 21, 'All maintained cases must collect; setup failures cannot replace behavior proof')
    for (const row of evaluations) {
      assert.equal(row.originalSHA256, inputs[row.path], 'The evaluated original source must match this proof input: ' + row.path)
      assert.ok(row.surface === 'vitest' || row.surface === 'node-process')
    }
    for (const path of goalOwnerRecoverySources) assert.ok(evaluations.some(row => row.path === path), 'An original source owner or consumer was not evaluated: ' + path)
    const cleanups = observations.filter(row => row.cleanup !== undefined)
    assert.equal(cleanups.length, cases.length, 'Each executed case must finish its actual resource cleanup')
    for (const test of cases) assert.ok(cleanups.some(row => row.case === test.fullName && row.cleanup === 'confirmed'), 'Missing actual case cleanup: ' + test.fullName)
    if (mutation) {
      assert.notEqual(run.code, 0, 'The implementation mutation must fail: ' + label)
      assert.ok(failures.length > 0 && failures.every(test => new RegExp(mutation.pattern).test(test.fullName)), 'Only the selected real consumers may fail')
      assert.ok(failures.some(test => test.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__/u.test(message))), 'A consumer assertion must detect the mutation; setup or timeout is not proof')
      for (const [path] of mutation.edits) assert.ok(evaluations.some(row => row.path === path && row.mutant === label && row.originalSHA256 !== row.loadedSHA256), 'The actual consumer did not evaluate the changed owner: ' + path)
    } else {
      assert.equal(run.code, 0, run.output); assert.equal(cases.length, 21); assert.equal(failures.length, 0)
      const names = cases.map(test => test.fullName).sort()
      if (originalCases) assert.deepEqual(names, originalCases, 'Restoration must rerun the same real cases')
      else originalCases = names
      assert.ok(evaluations.some(row => row.path === 'apps/host/src/continuous-progress-loop-store.ts' && row.surface === 'node-process'), 'The separately reopened Store must execute its source in the independent process')
      const readers = observations.filter(row => row.phase === 'independent-store-reader')
      assert.equal(readers.length, 1, 'Exactly one actual independent Store reader must complete')
      const reader = readers[0]
      assert.notEqual(reader.pid, reader.parentPid)
      assert.equal(hash(await readFile(resolve(root, reader.file))), reader.bundleSHA256)
      const provenanceBytes = await readFile(resolve(root, reader.provenance))
      assert.equal(hash(provenanceBytes), reader.provenanceSHA256)
      const provenance = JSON.parse(provenanceBytes)
      assert.equal(provenance.bundleSHA256, reader.bundleSHA256)
      assert.ok(provenance.sources.some(source => source.path === 'apps/host/src/continuous-progress-loop-store.ts'), 'The bundle must contain the original Store implementation')
      for (const source of provenance.sources) {
        assert.equal(hash(await readFile(resolve(root, source.path))), source.originalSHA256, 'A bundled original source changed: ' + source.path)
        if (inputs[source.path]) assert.equal(source.originalSHA256, inputs[source.path])
        else inputs[source.path] = source.originalSHA256
      }
    }
    await checkInputs()
    evidence.validated = true; delete receipt.current
    await save()
    process.stdout.write(JSON.stringify({ label, exitCode: run.code, passed: cases.length - failures.length, failed: failures.length }) + '\n')
  }
  await checkInputs()
  receipt.passed = true; receipt.unchanged = true
  await save()
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, receipt: '.local/state/mobile-independent-host/review-remediation/goal-owner-recovery/receipt.json', attempt: receipt.attempt }) + '\n')
} catch (error) {
  receipt.error = { name: error.name, message: error.message, stack: error.stack }
  await save()
  process.stdout.write(JSON.stringify({ passed: false, receipt: relative(root, resolve(attempt, 'receipt.json')) }) + '\n')
  throw error
}
