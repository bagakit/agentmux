import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(root, '.local/state/rpc-stream-writer', String(Date.now()))
await mkdir(evidence, { recursive: true })
const file = join(root, 'packages/core/src/rpc-stream-transport.ts')
const hash = value => createHash('sha256').update(value).digest('hex')
const source = hash(await readFile(file)), receipt = { passed: false, sourcePath: file, sourceSHA256: source, cases: [], scope: 'Actual shared stream transport and request-ID map with controlled Node Writable false/drain, cancellation, physical close/error. No Native/App/CLI/wide product gate or actual64MiB allocation.' }
try {
  receipt.inputs = {}
  for (const path of ['packages/core/test/rpc-stream-writer.test.ts', 'packages/core/test/rpc-stream-writer.config.mts', 'packages/core/scripts/verify-rpc-stream-writer.mjs']) receipt.inputs[path] = hash(await readFile(join(root, path)))
  for (const mutation of [null, 'aggregate-cap', 'ignore-drain', 'keep-cancelled-queued', 'forget-close-settlement', null]) {
    const label = mutation ?? (receipt.cases.length ? 'restored' : 'baseline')
    const reportFile = join(evidence, label + '.json'), loaded = join(evidence, label + '.loaded.json')
    const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', join(root, 'packages/core/test/rpc-stream-writer.config.mts'), '--reporter=json', '--outputFile=' + reportFile]
    const run = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_WRITER_MUTATION: mutation ?? '', AGENTMUX_WRITER_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b)
      child.once('error', no); child.once('close', (exit, signal) => yes({ exit, signal, output }))
    })
    await writeFile(join(evidence, label + '.log'), run.output)
    const report = JSON.parse(await readFile(reportFile)), evaluated = JSON.parse(await readFile(loaded))
    assert.equal(evaluated.originalSHA256, source); assert.equal(run.signal, null); assert.equal(report.numTotalTests, 4)
    assert.equal(report.testResults.length, 1); assert.equal(report.testResults[0].assertionResults.length, 4)
    if (mutation) {
      assert.ok(run.exit > 0 && report.numFailedTests > 0)
      assert.notEqual(evaluated.evaluatedSHA256, source)
      assert.ok(report.testResults[0].assertionResults.some(a => a.status === 'failed' && a.failureMessages.some(v => v.includes('AssertionError'))))
    } else { assert.equal(run.exit, 0); assert.equal(report.numPassedTests, 4); assert.equal(report.numFailedTests, 0); assert.equal(evaluated.evaluatedSHA256, source) }
    receipt.cases.push({ label, command: [process.execPath, ...args], exit: run.exit, passed: report.numPassedTests, failed: report.numFailedTests, reportSHA256: hash(await readFile(reportFile)), evaluated })
  }
  receipt.sourceAfterSHA256 = hash(await readFile(file)); assert.equal(receipt.sourceAfterSHA256, source)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(join(evidence, 'receipt.json')) }
