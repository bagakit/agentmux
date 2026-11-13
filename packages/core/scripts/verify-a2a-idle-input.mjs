import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { idleInputMutations, idleInputOwners } from '../test/fixtures/a2a-idle-input-proof.mjs'
import { assertLoadedNativeSources, assertNativeSourcePair, nativeMutationTarget, nativeSourceConditions } from './lib/a2a-reference-proof.mjs'
import { a2aSourceClosure, a2aSourceCompileInputs, freezeA2aPreparedSource, isA2aSourcePath } from './lib/a2a-prepared-source.mjs'

// Source adapter qualification is separate from the real CLI/Runtime and native
// actor proofs. Its only mocked authority is the adapter's OS process locator.
const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--prepared-source')
const evidence = join(root, '.tmp', `a2a-idle-input-proof-${Date.now()}`)
let sourceRoot = root, sourceCopy, fixedSources
const config = 'packages/core/test/vitest.a2a-idle-input.config.mts'
const tests = ['packages/core/test/a2a-idle-input.test.ts', 'packages/core/test/a2a-reference-budget.test.ts', 'packages/core/test/codex-idle-queue.test.ts']
const regressions = ['packages/core/test/current-terminal-prompt.test.ts', 'packages/core/test/native-prompt-authority-store.test.ts']
const mutations = ['native-queue-becomes-steer', 'native-idle-target-is-omitted', 'completion-fence-is-omitted',
  'final-input-fence-is-omitted', 'notification-identity-is-omitted', 'edited-notification-is-adopted',
  'native-queue-receipt-is-unchecked', 'notification-identity-is-not-restored',
  'independent-idle-notification-is-blocked', 'independent-idle-completion-is-consumed',
  'controlled-notice-reservation-spills-to-other-key', 'uncontrolled-notice-reservation-spills-to-other-key']
const closure = await a2aSourceClosure(path => readFile(join(root, path), 'utf8'))
const inputs = [...idleInputOwners.map(file => 'packages/core/src/' + file), ...a2aSourceCompileInputs(closure)]
inputs.push(...tests, ...regressions, config, 'packages/core/test/fixtures/a2a-idle-input-proof.mjs', 'packages/core/scripts/verify-a2a-idle-input.mjs',
  'packages/core/scripts/lib/a2a-prepared-source.mjs', 'packages/core/scripts/lib/a2a-reference-proof.mjs', 'packages/core/test/helpers/public-rpc-owner.ts',
  'packages/core/test/helpers/fixture-values.ts', 'test/fixture-values.mjs', 'test/fixture-epoch.cjs', 'pnpm-lock.yaml')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const product = path => isA2aSourcePath(path, closure)
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(join(product(file) ? sourceRoot : root, file)))])))
const receipt = { schema: 'agentmux.a2a-idle-input-owning-proof.v1', sourceOnly: true, sharedTreeMutations: 0, passed: false, cases: [] }

await mkdir(evidence, { recursive: true })
async function run(label, mutation, selected = tests, count = 50) {
  const output = join(evidence, label + '.json'), loaded = join(evidence, label + '.loaded.jsonl')
  await writeFile(loaded, '')
  const env = { ...process.env, AGENTMUX_IDLE_INPUT_LOADED: loaded }
  env.AGENTMUX_IDLE_INPUT_SOURCE_ROOT = sourceRoot
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
  assert.equal(report.numTotalTests, count, label + ': exact nonempty owning inventory')
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  const assertionFailures = failures.filter(test => test.failureMessages.some(message =>
    message.includes('AssertionError') || /__VITEST_(?:RESOLVES|REJECTS)__/u.test(message))).length
  const records = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const transformed = records.filter(record => record.mutation)
  assert.ok(records.length > 0, label + ': actual source graph was not observed')
  nativeSourceConditions(records, mutation ? nativeMutationTarget(mutation) : undefined)
  // A fixed commit binds every loaded file to its blob; a captured checkout binds only the declared owners.
  const files = fixedSources ?? new Map(await Promise.all(idleInputOwners.map(async file =>
    ['packages/core/src/' + file, await readFile(join(root, 'packages/core/src', file), 'utf8')])))
  assertLoadedNativeSources(records, { files, hashes: receipt.sourceBefore, complete: Boolean(fixedSources) })
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
  if (args.length) {
    const preparation = JSON.parse(await readFile(resolve(root, args[1]), 'utf8'))
    sourceCopy = join(evidence, 'source')
    const frozen = await freezeA2aPreparedSource(preparation, { root, destination: sourceCopy })
    assert.deepEqual(frozen.closure, closure, 'The harness and the fixed commit compile one workspace closure')
    sourceRoot = frozen.sourceRoot; receipt.sourceOrigin = frozen.origin
    fixedSources = new Map([...frozen.blobs].map(([path, bytes]) => [path, bytes.toString()]))
    receipt.sourceScope = 'Every loaded workspace source and its compiler configuration is the fixed commit blob; tests, helpers and third-party packages are captured from the checkout, whose lockfile equals the fixed one.'
  } else {
    receipt.sourceOrigin = { kind: 'captured-checkout' }
    receipt.sourceScope = 'Declared input-contract owners and harness remain exact; other loaded workspace sources are historical test conditions, equal within each mutation/restoration pair.'
  }
  for (const mutation of mutations) {
    const edit = idleInputMutations[mutation]
    assert.ok(edit, 'Every owning mutation has its exact source edit: ' + mutation)
    const source = await readFile(join(sourceRoot, 'packages/core/src', edit[0]), 'utf8')
    assert.equal(source.split(edit[1]).length, 2, 'Unique original source target before running tests: ' + mutation)
  }
  receipt.sourceBefore = await hashes()
  receipt.baseline = await run('baseline')
  receipt.regression = await run('original-manual-author', undefined, regressions, 30)
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
  if (sourceCopy) {
    try { await rm(sourceCopy, { recursive: true, force: true }); receipt.cleanup = { sourceCopyRemoved: true } }
    catch (error) { receipt.passed = false; receipt.cleanup = { sourceCopyRemoved: false, error: error.message } }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message ?? receipt.cleanup?.error)
process.stdout.write(JSON.stringify({ passed: true, sourceOnly: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }) + '\n')
