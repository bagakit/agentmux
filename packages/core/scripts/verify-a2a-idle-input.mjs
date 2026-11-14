import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { idleInputMutations, idleInputOwners } from '../test/fixtures/a2a-idle-input-proof.mjs'
import { assertLoadedNativeSources, assertNativeSourcePair, nativeMutationTarget, nativeSourceConditions } from './lib/a2a-reference-proof.mjs'

// Source adapter qualification is separate from the real CLI/Runtime and native
// actor proofs. Its only mocked authority is the adapter's OS process locator.
const root = resolve(import.meta.dirname, '../../..')
assert.equal(process.argv.length, 2, 'This gate takes no arguments; it runs the committed checkout')
const evidence = join(root, '.tmp', `a2a-idle-input-proof-${Date.now()}`)
const config = 'packages/core/test/vitest.a2a-idle-input.config.mts'
const tests = ['packages/core/test/a2a-idle-input.test.ts', 'packages/core/test/a2a-reference-budget.test.ts', 'packages/core/test/codex-idle-queue.test.ts']
const regressions = ['packages/core/test/current-terminal-prompt.test.ts', 'packages/core/test/native-prompt-authority-store.test.ts']
const mutations = ['native-queue-becomes-steer', 'native-idle-target-is-omitted', 'completion-fence-is-omitted',
  'final-input-fence-is-omitted', 'notification-identity-is-omitted', 'edited-notification-is-adopted',
  'native-queue-receipt-is-unchecked', 'notification-identity-is-not-restored',
  'independent-idle-notification-is-blocked', 'independent-idle-completion-is-consumed',
  'controlled-notice-reservation-spills-to-other-key', 'uncontrolled-notice-reservation-spills-to-other-key']
const owners = idleInputOwners
const inputs = [...owners, ...tests, ...regressions, config, 'packages/core/test/fixtures/a2a-idle-input-proof.mjs', 'packages/core/scripts/verify-a2a-idle-input.mjs',
  'packages/core/scripts/lib/a2a-reference-proof.mjs', 'packages/core/test/helpers/public-rpc-owner.ts',
  'packages/core/test/helpers/fixture-values.ts', 'test/fixture-values.mjs', 'test/fixture-epoch.cjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.a2a-idle-input-owning-proof.v1', sourceOnly: true, sharedTreeMutations: 0, passed: false, cases: [],
  sourceScope: 'Declared input-contract owners and harness remain exact; other loaded workspace sources are test conditions, equal within each mutation/restoration pair.' }

await mkdir(evidence, { recursive: true })
async function run(label, mutation, selected = tests) {
  const output = join(evidence, label + '.json'), loaded = join(evidence, label + '.loaded.jsonl')
  await writeFile(loaded, '')
  const env = { ...process.env, AGENTMUX_IDLE_INPUT_LOADED: loaded }
  delete env.AGENTMUX_TEST_RPC_CORE_ENTRY
  delete env.AGENTMUX_IDLE_INPUT_MUTATION
  if (mutation) env.AGENTMUX_IDLE_INPUT_MUTATION = mutation
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      ...selected, '--maxWorkers=1', '--reporter=json', '--outputFile=' + output], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, log }))
  })
  await writeFile(join(evidence, label + '.log'), result.log)
  assert.equal(result.signal, null, label + ': interrupted test process')
  const report = JSON.parse(await readFile(output, 'utf8'))
  // Every named file must be collected and hold real assertions; an empty or missing file is no proof.
  assert.deepEqual(report.testResults.map(file => file.name.slice(root.length + 1)).sort(), [...selected].sort(), label + ': every named test file was collected')
  assert.ok(report.testResults.every(file => file.assertionResults.length > 0), label + ': every named test file holds tests')
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  const assertionFailures = failures.filter(test => test.failureMessages.some(message =>
    message.includes('AssertionError') || /__VITEST_(?:RESOLVES|REJECTS)__/u.test(message))).length
  const records = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const transformed = records.filter(record => record.mutation)
  assert.ok(records.length > 0, label + ': actual source graph was not observed')
  nativeSourceConditions(records, mutation ? nativeMutationTarget(mutation) : undefined)
  const files = new Map(await Promise.all(owners.map(async path => [path, await readFile(join(root, path), 'utf8')])))
  assertLoadedNativeSources(records, { files, hashes: receipt.sourceBefore })
  if (mutation) {
    assert.ok(result.code > 0 && report.numFailedTests > 0 && assertionFailures > 0, label + ': mutation must fail a behavior assertion')
    assert.ok(transformed.length > 0 && transformed.every(record => record.mutation === mutation && record.sha256 !== record.originalSHA256),
      label + ': actual targeted source must be transformed')
  } else {
    assert.equal(result.code, 0, label + ': baseline failed; retain its original log')
    assert.equal(report.numFailedTests, 0)
    assert.equal(transformed.length, 0)
  }
  return { exit: result.code, tests: report.numTotalTests, failed: report.numFailedTests, assertionFailures,
    report: label + '.json', log: label + '.log', loaded: label + '.loaded.jsonl', transformed }
}

try {
  for (const mutation of mutations) {
    const edit = idleInputMutations[mutation]
    assert.ok(edit, 'Every owning mutation has its exact source edit: ' + mutation)
    const source = await readFile(join(root, 'packages/core/src', edit[0]), 'utf8')
    assert.equal(source.split(edit[1]).length, 2, 'Unique original source target before running tests: ' + mutation)
  }
  receipt.sourceBefore = await hashes()
  receipt.baseline = await run('baseline')
  receipt.regression = await run('original-manual-author', undefined, regressions)
  for (const mutation of mutations) {
    const red = await run(mutation + '-red', mutation)
    const restored = await run(mutation + '-restored')
    const loaded = async run => (await readFile(join(evidence, run.loaded), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assertNativeSourcePair(await loaded(red), await loaded(restored), mutation)
    receipt.cases.push({ mutation, red, restored })
    assert.deepEqual(await hashes(), receipt.sourceBefore)
    process.stdout.write(mutation + ': Assertion RED -> GREEN\n')
  }
  receipt.sourceAfter = await hashes()
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) {
  receipt.failure = { message: error.message, stack: error.stack }
} finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
process.stdout.write(JSON.stringify({ passed: true, sourceOnly: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }) + '\n')
