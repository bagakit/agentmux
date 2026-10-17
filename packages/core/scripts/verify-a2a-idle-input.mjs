import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Source adapter qualification is separate from the real CLI/Runtime and native
// actor proofs. Its only mocked authority is the adapter's OS process locator.
const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp', `a2a-idle-input-proof-${Date.now()}`)
const config = 'packages/core/test/vitest.a2a-idle-input.config.mts'
const tests = ['packages/core/test/a2a-idle-input.test.ts', 'packages/core/test/codex-idle-queue.test.ts']
const regressions = ['packages/core/test/current-terminal-prompt.test.ts', 'packages/core/test/native-prompt-authority-store.test.ts']
const mutations = ['native-queue-becomes-steer', 'native-idle-target-is-omitted', 'completion-fence-is-omitted',
  'final-input-fence-is-omitted', 'notification-identity-is-omitted', 'edited-notification-is-adopted',
  'native-queue-receipt-is-unchecked', 'notification-identity-is-not-restored',
  'independent-idle-notification-is-blocked', 'independent-idle-completion-is-consumed']
const inputs = ['types.ts', 'agent-provider.ts', 'prompt-submission.ts', 'prompt-submission-record.ts',
  'providers/codex-native-input.ts', 'native-input-adoption.ts'].map(file => 'packages/core/src/' + file)
inputs.push(...tests, ...regressions, config, 'packages/core/scripts/verify-a2a-idle-input.mjs')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.a2a-idle-input-owning-proof.v1', sourceOnly: true, sharedTreeMutations: 0, passed: false, cases: [] }

await mkdir(evidence, { recursive: true })
async function run(label, mutation, selected = tests, count = 19) {
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
  const report = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(result.signal, null, label + ': interrupted test process')
  assert.equal(report.numTotalTests, count, label + ': exact nonempty owning inventory')
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  const assertionFailures = failures.filter(test => test.failureMessages.some(message =>
    message.includes('AssertionError') || /__VITEST_(?:RESOLVES|REJECTS)__/u.test(message))).length
  const records = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const transformed = records.filter(record => record.mutation)
  assert.ok(records.length > 0, label + ': actual source graph was not observed')
  for (const record of records) assert.equal(hash(await readFile(join(root, 'packages/core/src', record.file))), record.originalSHA256,
    label + ': source changed while loading ' + record.file)
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
  receipt.sourceBefore = await hashes()
  receipt.baseline = await run('baseline')
  receipt.regression = await run('original-manual-author', undefined, regressions, 30)
  for (const mutation of mutations) {
    const red = await run(mutation + '-red', mutation)
    const restored = await run(mutation + '-restored')
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
