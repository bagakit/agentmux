import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { commitContentionMutations, hash } from '../test/fixtures/session-commit-contention/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.local/state/mobile-independent-host/session-commit-contention')
await mkdir(directory, { recursive: true })
const test = 'packages/core/test/session-commit-contention.test.ts'
const config = 'packages/core/test/fixtures/session-commit-contention/vitest.config.mts'
const files = ['packages/core/scripts/verify-session-commit-contention.mjs', test, config,
  'packages/core/test/fixtures/session-commit-contention/mutations.mjs', 'packages/core/test/fixtures/session-commit-contention/node-loader.mjs',
  'packages/core/test/fixtures/session-commit-contention/reader.mjs', 'packages/core/test/helpers/public-rpc-owner.ts',
  'packages/core/test/helpers/source-object-cli.ts', 'apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs',
  'packages/core/package.json', 'vitest.setup.ts']
const inputs = async () => Object.fromEntries(await Promise.all(files.map(async path => [path, hash(await readFile(resolve(root, path)))])))
const expectedInputs = await inputs(), originalSources = new Map(), runs = []
const conditions = { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, architecture: process.arch,
  scope: 'Source FileStore and SDK, independent real SQLite connections and reader process, and original public RPC/CLI. Native byte I/O is the maintained controlled rpcOwnerFixture port. No user namespace, installed App, Browser, physical phone or actual Provider process qualification.' }
const requiredFacts = ['same-process-store', 'cross-process-store', 'cancelled-commit', 'exhausted-commit', 'non-busy-commit',
  'inactive-commit', 'sdk-original-input-receipt', 'sdk-original-input', 'public-original-input']
let originalNames
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
for (const label of ['baseline', ...Object.keys(commitContentionMutations), 'restored']) {
  const mutant = Object.hasOwn(commitContentionMutations, label), loaded = resolve(directory, label + '-loaded.jsonl')
  const result = resolve(directory, label + '-result.json'), facts = resolve(directory, label + '-facts.jsonl')
  await Promise.all([writeFile(loaded, ''), writeFile(facts, '')])
  const mutation = mutant ? commitContentionMutations[label] : null
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', config, '--reporter=json', '--outputFile=' + result,
      ...(mutation ? ['-t', mutation.test] : [])],
      { cwd: root, env: { ...env, AGENTMUX_TEST_COMMIT_CONTENTION_MUTANT: mutant ? label : '',
        AGENTMUX_TEST_COMMIT_CONTENTION_LOADED: loaded, AGENTMUX_TEST_COMMIT_CONTENTION_FACTS: facts }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  assert.equal(run.signal, null, 'The actual focused process must complete without external termination')
  const report = JSON.parse(await readFile(result, 'utf8'))
  const assertions = report.testResults.flatMap(suite => suite.assertionResults), names = assertions.map(test => test.fullName).sort()
  assert.equal(report.numTotalTests, 10, 'The exact owning consumer set must be completely collected')
  assert.equal(assertions.length, 10)
  assert.equal(report.numPassedTests + report.numFailedTests, mutation?.count ?? 10, 'Every selected focused consumer must execute')
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0, 'Import, setup and process failures cannot qualify')
  if (originalNames) assert.deepEqual(names, originalNames, 'The original exact consumer set must remain unchanged')
  else originalNames = names
  const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(evaluations.length > 0, 'Actual evaluated Source must be observed')
  for (const row of evaluations) {
    const previous = originalSources.get(row.path)
    if (previous) assert.equal(row.sourceSHA256, previous, 'The actual source input changed: ' + row.path)
    else originalSources.set(row.path, row.sourceSHA256)
  }
  const observations = (await readFile(facts, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const failures = assertions.filter(test => test.status === 'failed')
  if (mutant) {
    assert.ok(Number.isInteger(run.code) && run.code > 0, 'The original consumer must reject the changed owner')
    assert.equal(failures.length, mutation.count, 'Each selected business boundary must reject the mutation')
    assert.ok(failures.every(test => test.fullName.includes(mutation.test) && test.failureMessages.some(message => /AssertionError|__VITEST_REJECTS__|__VITEST_RESOLVES__/u.test(message))),
      'A real behavior assertion must reject the mutation; timeout, import and setup failure are not evidence')
    assert.ok(evaluations.some(row => row.mutant === label && row.sourceSHA256 !== row.loadedSHA256 && row.replacements > 0),
      'The exact changed production owner must actually execute')
  } else {
    assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, report.numTotalTests)
    for (const path of ['packages/core/src/agent-session-store.ts', 'packages/core/src/agent-session-database.ts',
      'packages/core/src/agent-session-registry.ts', 'packages/core/src/client.ts', 'packages/core/src/public-rpc-service.ts',
      'packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-commands.ts'])
      assert.ok(evaluations.some(row => row.path === path), 'The original production consumer must execute: ' + path)
    for (const name of requiredFacts) assert.ok(observations.some(row => row.name === name), 'The owning behavior must have actual evidence: ' + name)
    const cleanup = observations.filter(row => row.cleanup !== undefined)
    assert.equal(cleanup.length, report.numPassedTests, 'Every executed consumer must report its own actual cleanup')
    assert.ok(cleanup.every(row => row.cleanup === 'confirmed'), 'Every private fixture must complete its actual cleanup')
    const reader = observations.find(row => row.name === 'cross-process-store').reader
    assert.equal(reader.node, conditions.node); assert.equal(reader.sqlite, conditions.sqlite)
    const publicInput = observations.find(row => row.name === 'public-original-input')
    assert.deepEqual(publicInput.results.map(result => result.producer), ['rpc', 'cli'])
    assert.equal(publicInput.inputCalls, 4)
  }
  runs.push({ label, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests, evaluations, observations,
    assertions: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
  process.stdout.write(JSON.stringify({ label, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
}
assert.deepEqual(await inputs(), expectedInputs, 'The focused fixture inputs changed during the proof')
for (const [path, expected] of originalSources) assert.equal(hash(await readFile(resolve(root, path))), expected, 'The actual loaded source changed: ' + path)
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.session-commit-contention-proof.v1',
  conditions, inputs: expectedInputs, originalSourceHashes: Object.fromEntries(originalSources), runs }, null, 2) + '\n')
