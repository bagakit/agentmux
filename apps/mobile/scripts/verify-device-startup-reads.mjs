import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const vitest = createRequire(resolve(mobile, 'package.json')).resolve('vitest/vitest.mjs')
const directory = resolve(root, '.tmp/mobile-device-startup-reads', 'run-' + randomUUID())
await mkdir(directory, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const production = ['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/recovery/device-workface.ts',
  'apps/mobile/src/conversation/local-drafts.ts', 'apps/mobile/src/conversation/attachment-page-owner.ts']
const consumers = ['apps/mobile/test/device-startup-reads.test.tsx', 'apps/mobile/test/device-workface.test.tsx',
  'apps/mobile/test/concurrent-drafts.test.tsx', 'apps/mobile/test/mobile-update-workface.test.tsx']
const files = [...production, ...consumers, 'apps/mobile/test/device-startup-reads.config.mts', 'apps/mobile/scripts/verify-device-startup-reads.mjs']
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const bearing = {
  'navigation-full-read': 'startup navigation must avoid full-record snapshots',
  'uploads-full-read': 'startup attachments must avoid full-record snapshots',
  'duplicate-draft-read': 'startup drafts must reuse one full snapshot'
}
const outsideScope = [
  'one durable mobile workface owner preserves Core spatial ID references from actual mounted space through backup and a new owner without replaying unknown input',
  'one durable mobile workface owner preserves Core spatial ID references from actual mounted survey through backup and a new owner without replaying unknown input',
  'one durable mobile workface owner exports the actual temporary app Session selection beside an unreadable original record without writing it'
].sort()
const expectedSelected = [5, 19, 10, 5]
const receipt = { schema: 'agentmux.mobile-device-startup-reads.v1', passed: false, inputs, runs: [],
  selectedCases: consumers.map((file, index) => ({ file, count: expectedSelected[index] })), outsideScope,
  scope: 'Actual MobileApp and original DeviceWorkfaceStore/draft/upload owners over isolated DOM Storage and fixed public SDK fixture leaves; original update handoff lock and cross-page preservation consumers. Logical copied JSON payload is not physical heap or real-phone elapsed time.' }
let baselineNames
try {
  for (const label of ['baseline', ...Object.keys(bearing), 'restored']) {
    const mutated = label in bearing, loaded = resolve(directory, label + '-loaded.jsonl'), report = resolve(directory, label + '-result.json'), metrics = resolve(directory, label + '-metrics.jsonl')
    await writeFile(loaded, ''); await writeFile(metrics, '')
    const env = { ...process.env, DEVICE_STARTUP_READ_LOADED: loaded, DEVICE_STARTUP_READ_METRICS: metrics }
    delete env.DEVICE_STARTUP_READ_MUTATION
    if (mutated) env.DEVICE_STARTUP_READ_MUTATION = label
    const command = ['exec', 'vitest', 'run', '--config', 'test/device-startup-reads.config.mts', '--reporter=json', '--outputFile=' + report]
    const run = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [vitest, ...command.slice(2)], { cwd: mobile, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log }))
    })
    await writeFile(resolve(directory, label + '.log'), run.log)
    assert.equal(run.signal, null)
    const result = JSON.parse(await readFile(report, 'utf8'))
    const tests = result.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const evaluated = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.phase === 'evaluated')
    assert.ok(tests.length > 0, 'Nonempty actual consumer collection')
    for (const file of [...production, ...(mutated ? consumers.slice(0, 1) : consumers)]) {
      assert.ok(evaluated.some(row => row.file === file && row.originalSHA256 === inputs[file]), 'Original owner/consumer actually evaluated: ' + file)
    }
    const measured = (await readFile(metrics, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (mutated) {
      assert.notEqual(run.code, 0); assert.equal(tests.length, 1); assert.equal(result.numFailedTests, 1); assert.equal(result.numPassedTests, 0)
      assert.ok(tests[0].fullName.includes('restores 1572864 bytes through MobileApp'))
      assert.ok(tests[0].failureMessages.some(message => message.includes('AssertionError') && message.includes(bearing[label])), 'Exact cost assertion, not collection/setup/timeout, must fail: ' + label)
      assert.ok(evaluated.some(row => row.mutation === label && row.originalSHA256 === inputs[row.file] && row.loadedSHA256 !== row.originalSHA256), 'Loaded original source changed for ' + label)
      assert.equal(measured.length, 1); assert.equal(measured[0].fullSnapshotCount, 2)
    } else {
      assert.equal(run.code, 0, run.log); assert.equal(result.numFailedTests, 0)
      assert.equal(result.numPendingTests, outsideScope.length); assert.equal(result.numTodoTests, 0)
      const unselected = result.testResults.flatMap(file => file.assertionResults).filter(test => ['pending', 'skipped'].includes(test.status)).map(test => test.fullName).sort()
      assert.deepEqual(unselected, outsideScope, 'Only the exact three diagnosed legacy fixture cases remain outside this narrow gate')
      assert.equal(result.testResults.length, consumers.length)
      for (const [index, file] of consumers.entries()) {
        const entry = result.testResults.find(entry => entry.name.endsWith(file))
        const selected = entry?.assertionResults.filter(test => !['pending', 'skipped'].includes(test.status))
        assert.equal(selected?.length, expectedSelected[index], 'Exact selected consumer count: ' + file)
        assert.ok(selected.every(test => test.status === 'passed'), 'Actual selected consumers pass: ' + file)
      }
      const names = tests.map(test => test.fullName).sort()
      if (label === 'baseline') baselineNames = names
      else assert.deepEqual(names, baselineNames, 'Restored full baseline collection preserved')
      assert.ok(evaluated.every(row => row.loadedSHA256 === row.originalSHA256))
      assert.equal(measured.length, 2)
      for (const sample of measured) { assert.equal(sample.fullSnapshotCount, 1); assert.equal(sample.logicalFullRecordBytes, sample.bytes) }
    }
    for (const [file, hash] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), hash, 'Source unchanged: ' + file)
    receipt.runs.push({ label, command: ['pnpm', ...command], exitCode: run.code,
      tests: tests.map(test => ({ name: test.fullName, status: test.status })), evaluated, measured,
      reportSHA256: sha(await readFile(report)), logSHA256: sha(run.log) })
    process.stdout.write(JSON.stringify({ label, passed: result.numPassedTests, failed: result.numFailedTests }) + '\n')
  }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: relative(root, resolve(directory, 'receipt.json')) }) + '\n')
