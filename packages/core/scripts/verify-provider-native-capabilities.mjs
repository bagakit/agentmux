import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mutations, scopes } from '../test/vitest.provider-native-capabilities.config.mjs'

const root = resolve(import.meta.dirname, '../../..'), scope = process.argv[process.argv.indexOf('--scope') + 1]
assert.ok(Object.hasOwn(scopes, scope), 'Choose --scope input, history or join')
const evidence = join(root, '.tmp/provider-native-capabilities', scope)
const config = 'packages/core/test/vitest.provider-native-capabilities.config.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = ['packages/core/src/agent-provider.ts', 'packages/core/src/prompt-submission.ts',
  'packages/core/src/client.ts', 'packages/core/src/agent-native-process.ts', 'packages/core/native/native-socket-peer.c',
  'packages/core/src/providers/codex-native-input.ts', 'packages/core/src/providers/codex-native-queue.ts',
  ...scopes[scope], config, 'packages/core/scripts/verify-provider-native-capabilities.mjs']
// These subprocess fixtures are actual proof inputs, outside Vite's loaded graph.
inputs.push(...(scope === 'input' ? ['packages/core/test/fixtures/codex-queue-rpc.mjs']
  : scope === 'history' ? ['packages/core/test/fixtures/native-history-session.ts', 'packages/core/test/helpers/codex-saved-question.ts']
  : ['packages/core/test/fixtures/codex-queue-native-worker.mjs', 'packages/core/test/helpers/source-object-cli.ts',
    'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/src/agentmux.ts',
    'apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs']))
const snapshot = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.provider-native-capabilities-proof.v1', scope, sourceOnly: true, passed: false, cases: [] }
const loadedSourceHashes = {}, dependencySourceHashes = {}
await mkdir(evidence, { recursive: true })

async function run(label, selected, mutation) {
  const output = join(evidence, label + '.json'), loaded = join(evidence, label + '.loaded.jsonl')
  await writeFile(loaded, '')
  const env = { ...process.env, AGENTMUX_PROVIDER_CAPABILITY_LOADED: loaded }
  for (const name of ['AGENTMUX_TEST_RPC_CORE_ENTRY', 'AGENTMUX_IDLE_INPUT_MUTATION', 'AGENTMUX_PROVIDER_CAPABILITY_MUTATION']) delete env[name]
  if (mutation) env.AGENTMUX_PROVIDER_CAPABILITY_MUTATION = mutation
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      ...selected, '--reporter=json', '--outputFile=' + output], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, log }))
  })
  await writeFile(join(evidence, label + '.log'), result.log)
  const report = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(result.signal, null, label + ': interrupted process')
  assert.ok(report.numTotalTests > 0, label + ': empty inventory')
  assert.equal(report.numPendingTests, 0, label + ': skipped proof is not acceptance')
  assert.equal(report.testResults.length, selected.length, label + ': missing owning file')
  for (const file of selected) assert.ok(report.testResults.some(suite => suite.name === join(root, file) && suite.assertionResults.length > 0), label + ': missing owning cases ' + file)
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  const assertionFailures = failures.filter(test => test.failureMessages.some(message =>
    message.includes('AssertionError') || /__VITEST_(?:RESOLVES|REJECTS)__/u.test(message))).length
  const records = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const transformed = records.filter(record => record.mutation)
  assert.ok(records.length > 0, label + ': actual source was not observed')
  for (const record of records) {
    if (dependencySourceHashes[record.file]) assert.equal(record.originalSHA256, dependencySourceHashes[record.file], label + ': prerequisite source changed while joining ' + record.file)
    if (loadedSourceHashes[record.file]) assert.equal(record.originalSHA256, loadedSourceHashes[record.file], label + ': source changed between runs ' + record.file)
    loadedSourceHashes[record.file] = record.originalSHA256
    assert.equal(hash(await readFile(join(root, record.file))), record.originalSHA256, label + ': source changed ' + record.file)
  }
  if (mutation) {
    assert.ok(result.code > 0 && report.numFailedTests > 0 && assertionFailures > 0, label + ': require behavior Assertion RED')
    assert.ok(transformed.length > 0 && transformed.every(record => record.mutation === mutation && record.sha256 !== record.originalSHA256), label + ': mutation was not loaded')
  } else {
    assert.equal(result.code, 0, label + ': baseline failed; inspect retained log')
    assert.equal(report.numFailedTests, 0)
    assert.equal(transformed.length, 0)
  }
  return { tests: report.numTotalTests, failed: report.numFailedTests, assertionFailures,
    report: label + '.json', loaded: label + '.loaded.jsonl', transformed }
}

try {
  receipt.sourceBefore = await snapshot()
  if (scope === 'join') {
    receipt.dependencies = {}
    for (const dependency of ['input', 'history']) {
      const proof = await readFile(join(root, '.tmp/provider-native-capabilities', dependency, 'receipt.json'))
      const value = JSON.parse(proof)
      assert.equal(value.passed, true, 'Missing successful ' + dependency + ' proof')
      assert.equal(value.cases.length, Object.values(mutations).filter(change => change[0] === dependency).length)
      assert.ok(value.loadedSourceHashes && Object.keys(value.loadedSourceHashes).length > 0, dependency + ': missing actual loaded source graph')
      for (const [file, sha] of Object.entries({ ...value.sourceAfter, ...value.loadedSourceHashes })) {
        assert.equal(hash(await readFile(join(root, file))), sha, dependency + ': proof no longer binds ' + file)
        if (dependencySourceHashes[file]) assert.equal(sha, dependencySourceHashes[file], dependency + ': conflicting source proofs ' + file)
        dependencySourceHashes[file] = sha
      }
      receipt.dependencies[dependency] = hash(proof)
    }
  }
  receipt.baseline = await run('baseline', scopes[scope])
  for (const [name, change] of Object.entries(mutations).filter(([, value]) => value[0] === scope)) {
    const selected = scope === 'input' ? [change[1].endsWith('/codex-native-queue.ts') ? scopes.input[2]
      : change[1].endsWith('/agent-native-process.ts') ? scopes.input[3] : scopes.input[0]] : scopes.history
    const red = await run(name + '-red', selected, name)
    const restored = await run(name + '-restored', selected)
    receipt.cases.push({ mutation: name, red, restored })
    assert.deepEqual(await snapshot(), receipt.sourceBefore, 'Candidate changed during verification')
    process.stdout.write(name + ': Assertion RED -> GREEN\n')
  }
  receipt.sourceAfter = await snapshot()
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  for (const [file, sha] of Object.entries({ ...dependencySourceHashes, ...loadedSourceHashes })) assert.equal(
    hash(await readFile(join(root, file))), sha, 'Source changed before proof completion: ' + file)
  receipt.loadedSourceHashes = loadedSourceHashes
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
assert.equal(receipt.passed, true, receipt.failure?.message)
process.stdout.write(JSON.stringify({ passed: true, scope, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }) + '\n')
