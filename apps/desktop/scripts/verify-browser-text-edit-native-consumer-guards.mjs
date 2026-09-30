import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

// Actual preserved Source/failed Native receipts test this entry, not Native editing.
const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const consumerPath = resolve(option('--consumer') ?? join(dirname(fileURLToPath(import.meta.url)), 'verify-browser-text-edit-native-receipt.mjs'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const identity = async path => { const bytes = await readFile(path); return { path: resolve(path), bytes: bytes.length, sha256: sha(bytes) } }
const sourceRoot = resolve('docs/reviews/evidence/browser-text-edit-source-2026-10-04/final-source')
const nativeRoot = resolve('docs/reviews/evidence/browser-operation-pointer-motion-native-2026-10-04/attempt-3')

async function suite() {
  const sourceBefore = await identity(consumerPath), g = await import(pathToFileURL(consumerPath).href)
  const sourceReceipt = join(sourceRoot, 'receipt.json'), nativeReceipt = join(nativeRoot, 'receipt.json')
  const nativeBytes = await readFile(nativeReceipt), native = JSON.parse(nativeBytes)
  const inputs = await Promise.all([sourceReceipt, nativeReceipt].map(identity))
  const scratch = await mkdtemp(join(tmpdir(), 'agentmux-text-edit-reader-tests-'))
  const results = []
  const test = async (name, work) => {
    try { await work(); results.push({ name, passed: true }) }
    catch (error) { results.push({ name, passed: false, failure: { code: error.code ?? error.name, message: error.message } }) }
  }
  const refused = report => {
    assert.equal(report.passed, false); assert.equal(report.nativePassed, false); assert.equal(report.taskComplete, false)
    assert.equal(report.adapterImplemented, false); assert.deepEqual(report.actions, [])
    assert.ok(report.missing.length > 0)
  }
  const fault = async (name, value) => { const path = join(scratch, name + '.json'); await writeFile(path, JSON.stringify(value)); return path }
  try {
    await test('actual-receipt-identity', async () => {
      const report = await g.verifyTextEditNativeReceipt(['--receipt', nativeReceipt]); refused(report)
      assert.deepEqual(report.evidence, { ...inputs.find(row => row.path === nativeReceipt), producerSchema: native.schema, reportedPassed: false })
      const raw = spawnSync(process.execPath, [consumerPath, '--receipt', nativeReceipt], { encoding: 'utf8' })
      assert.equal(raw.status, 2); assert.equal(raw.stderr, '')
      assert.deepEqual(JSON.parse(raw.stdout), report, 'The direct CLI actually consumes the same original receipt')
    })
    await test('actual-source-schema-stays-unsupported', async () => {
      const report = await g.verifyTextEditNativeReceipt(['--receipt', sourceReceipt]); refused(report)
      assert.equal(report.outcome, 'unsupported'); assert.equal(report.evidence.producerSchema, 'agentmux.browser-text-edit-source.v1')
      assert.equal(report.evidence.reportedPassed, 'unknown')
    })
    await test('actual-failed-native-stays-unsupported', async () => {
      assert.equal(native.passed, false)
      const report = await g.verifyTextEditNativeReceipt(['--receipt', nativeReceipt]); refused(report)
      assert.equal(report.outcome, 'unsupported'); assert.equal(report.evidence.reportedPassed, false)
    })
    await test('json-success-flags-cannot-certify', async () => {
      // A fault of the actual Source record, not a proposed Native producer contract.
      const sourceRecord = JSON.parse(await readFile(sourceReceipt)), path = await fault('false-success', { ...sourceRecord, passed: true, nativePassed: true, taskComplete: true })
      const report = await g.verifyTextEditNativeReceipt(['--receipt', path]); refused(report)
      assert.equal(report.outcome, 'unsupported'); assert.equal(report.evidence.reportedPassed, true)
    })
    for (const [name, value] of [['empty-object', {}], ['empty-array', []], ['null', null]]) await test('reject-' + name, async () => {
      const report = await g.verifyTextEditNativeReceipt(['--receipt', await fault(name, value)]); refused(report)
      assert.equal(report.outcome, 'rejected'); assert.equal(report.failure.code, 'ERR_ASSERTION')
    })
    await test('missing-receipt-stays-pending', async () => {
      const report = await g.verifyTextEditNativeReceipt(['--receipt', join(scratch, 'absent.json')]); refused(report)
      assert.equal(report.outcome, 'pending'); assert.equal(report.failure.code, 'ENOENT')
    })
    await test('malformed-receipt-rejected', async () => {
      const path = join(scratch, 'malformed.json'); await writeFile(path, '{"invalid":"do-not-echo-original-content"')
      const report = await g.verifyTextEditNativeReceipt(['--receipt', path]); refused(report)
      assert.equal(report.outcome, 'rejected'); assert.equal(report.failure.code, 'SyntaxError')
      assert.equal(report.reason, 'The supplied receipt is invalid JSON.')
      assert.ok(!JSON.stringify(report).includes('do-not-echo-original-content'))
    })
    await test('no-receipt-stays-pending', async () => { const report = await g.verifyTextEditNativeReceipt(); refused(report); assert.equal(report.outcome, 'pending') })
    await test('invalid-arguments-rejected', async () => { const report = await g.verifyTextEditNativeReceipt(['--build']); refused(report); assert.equal(report.outcome, 'rejected') })
    await test('official-entry-refuses-missing-evidence', async () => {
      const raw = spawnSync(process.execPath, [consumerPath, '--receipt', 'docs/reviews/evidence/browser-text-edit-native/receipt.json'], { encoding: 'utf8' })
      assert.equal(raw.status, 2); refused(JSON.parse(raw.stdout)); assert.equal(raw.stderr, '')
    })
    assert.ok(results.length > 0, 'The actual guard suite ran nonempty cases')
    assert.deepEqual(await identity(consumerPath), sourceBefore)
    for (const before of inputs) assert.deepEqual(await identity(before.path), before, 'Preserved original stayed unchanged')
  } finally { await rm(scratch, { recursive: true, force: true }) }
  return { schema: 'agentmux.browser-text-edit-native-reader-guards.v1', author: '/root/browser_source_closeout',
    scope: 'readonly-native-entry', guardSuitePassed: results.every(row => row.passed), nativePassed: false, taskComplete: false,
    source: sourceBefore, inputs, results, cleanup: { onlyOwnScratch: scratch, removed: true },
    notCovered: ['Real T027 producer/action/original binding adapter remains internal TODO',
      'No compiled/source/target/image relationships were verified', 'No native menu/shortcut editing or clipboard action was executed'] }
}

async function main() {
  if (args.includes('--test-only')) {
    const report = await suite(); process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.guardSuitePassed ? 0 : 1; return
  }
  const output = resolve(option('--evidence-root') ?? (() => { throw new Error('--evidence-root is required') })())
  await mkdir(output, { recursive: true })
  const before = await identity(consumerPath), source = await readFile(consumerPath, 'utf8')
  const scratch = await mkdtemp(join(tmpdir(), 'agentmux-text-edit-reader-mutants-'))
  const run = async (path, label) => {
    const raw = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--test-only', '--consumer', path], { encoding: 'utf8' })
    await writeFile(join(output, label + '.stdout.json'), raw.stdout)
    await writeFile(join(output, label + '.stderr.log'), raw.stderr)
    return { command: [process.execPath, fileURLToPath(import.meta.url), '--test-only', '--consumer', path], exitCode: raw.status,
      report: raw.stdout ? JSON.parse(raw.stdout) : null }
  }
  const mutants = [
    { name: 'actual-receipt-read', from: "  const originalPath = resolve(path), bytes = await readFile(originalPath)\n", to: "  const originalPath = resolve(path), bytes = Buffer.from('{}')\n", assertion: 'actual-receipt-identity' },
    { name: 'receipt-record', from: "  assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'A receipt is a nonempty record')\n  assert.ok(Object.keys(receipt).length > 0, 'Receipt fields are nonempty')\n", to: '', assertion: 'reject-empty-object' },
    { name: 'no-native-success-flags', from: "    scope: 'readonly-native-entry', passed: false, nativePassed: false, taskComplete: false,\n", to: "    scope: 'readonly-native-entry', passed: true, nativePassed: true, taskComplete: true,\n", assertion: 'json-success-flags-cannot-certify' },
    { name: 'official-refusal-exit', from: '  process.exitCode = 2\n', to: '  process.exitCode = 0\n', assertion: 'official-entry-refuses-missing-evidence' }
  ]
  const results = []
  let receipt
  try {
    await writeFile(join(output, 'consumer-original.mjs'), source)
    const officialArgs = [consumerPath, '--receipt', 'docs/reviews/evidence/browser-text-edit-native/receipt.json']
    const official = spawnSync(process.execPath, officialArgs, { encoding: 'utf8' })
    await writeFile(join(output, 'official.stdout.json'), official.stdout)
    await writeFile(join(output, 'official.stderr.log'), official.stderr)
    assert.equal(official.status, 2)
    const baseline = await run(consumerPath, 'baseline'); assert.equal(baseline.exitCode, 0)
    for (const mutant of mutants) {
      assert.equal(source.split(mutant.from).length - 1, 1, 'Mutation block exists exactly once: ' + mutant.name)
      const path = join(scratch, mutant.name + '.mjs'), mutated = source.replace(mutant.from, mutant.to)
      await writeFile(path, mutated); await writeFile(join(output, mutant.name + '.mutated.mjs'), mutated)
      const red = await run(path, mutant.name + '-red')
      const failure = red.report?.results.find(row => row.name === mutant.assertion)
      assert.equal(red.exitCode, 1); assert.equal(failure?.passed, false); assert.equal(failure.failure.code, 'ERR_ASSERTION')
      const restored = await run(consumerPath, mutant.name + '-restored'); assert.equal(restored.exitCode, 0)
      results.push({ name: mutant.name, blockSha256: sha(mutant.from), assertion: mutant.assertion, redExit: red.exitCode,
        actualAssertionFailure: failure.failure, restoredExit: restored.exitCode, restoredCases: restored.report.results.length })
    }
    assert.ok(results.length > 0)
    assert.deepEqual(await identity(consumerPath), before)
    for (const row of baseline.report.inputs) assert.deepEqual(await identity(row.path), row, 'Actual input stayed fixed across the guard/mutation run')
    receipt = { schema: 'agentmux.browser-text-edit-native-reader-source.v1',
      author: '/root/browser_source_closeout', sourcePassed: true, nativePassed: false, taskComplete: false, source: before,
      baselineCases: baseline.report.results.length, mutants: results, inputDrift: [],
      officialCommand: { command: [process.execPath, ...officialArgs], exitCode: official.status, outcome: JSON.parse(official.stdout).outcome },
      notCovered: baseline.report.notCovered, cleanup: { onlyOwnScratch: scratch, removed: false } }
  } finally { await rm(scratch, { recursive: true, force: true }) }
  receipt.cleanup.removed = true
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ evidenceRoot: output, guardCases: receipt.baselineCases, mutants: results.length, nativePassed: false }) + '\n')
}

await main()
