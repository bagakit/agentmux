import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { mobileChromeMutations } from '../test/mobile-chrome-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const directory = resolve(root, '.local/state/mobile-chrome', 'run-' + randomUUID())
const sourceFiles = [...new Set([...Object.values(mobileChromeMutations).map(entry => entry.file), 'apps/mobile/test/mobile-chrome.test.tsx',
  'apps/mobile/test/mobile-avatar-notice-consumer.test.tsx', 'apps/mobile/test/mobile-chrome-mutant.config.ts', 'apps/mobile/test/mobile-chrome-mutations.mjs', 'apps/mobile/scripts/verify-mobile-chrome.mjs'])]
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const receipt = { schema: 'agentmux.mobile-chrome.v1', passed: false, inputs, runs: [],
  scope: 'Actual MobileApp shell with the original DeviceWorkface and conversation surface over controlled catalog and SDK facts. Loaded source mutations verify their bearing assertions. Real-browser geometry, the soft-keyboard cascade and aesthetic review are separate capture evidence.' }
await mkdir(directory, { recursive: true })
try {
  for (const label of ['baseline', ...Object.keys(mobileChromeMutations), 'restored']) {
    const variant = mobileChromeMutations[label], loaded = resolve(directory, label + '-loaded.jsonl'), result = resolve(directory, label + '-result.json')
    await writeFile(loaded, '')
    const env = { ...process.env, MOBILE_CHROME_LOADED: loaded }; delete env.MOBILE_CHROME_MUTATION
    if (variant) env.MOBILE_CHROME_MUTATION = label
    const run = await new Promise((accept, reject) => {
      const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'test/mobile-chrome-mutant.config.ts', '--reporter=json', '--outputFile=' + result], { cwd: mobile, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log }))
    })
    await writeFile(resolve(directory, label + '.log'), run.log)
    assert.equal(run.signal, null)
    const report = JSON.parse(await readFile(result, 'utf8'))
    const tests = report.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
    for (const file of (variant ? [variant.file, 'apps/mobile/test/' + (variant.testFile ?? 'mobile-chrome.test.tsx')] : sourceFiles.filter(file => /\.tsx?$/u.test(file) && !file.endsWith('.config.ts')))) assert.ok(evaluations.some(row => row.path === file), 'Real owner and consumer must load: ' + file)
    if (variant) {
      assert.notEqual(run.code, 0, 'Mutated production behavior must fail its bearing test')
      assert.equal(tests.length, 1, 'Exactly the bearing test runs'); assert.equal(report.numFailedTests, 1); assert.equal(report.numPassedTests, 0)
      assert.ok(tests[0].fullName.includes(variant.target))
      assert.ok(tests[0].failureMessages.some(message => message.includes('AssertionError')), 'Import, setup and timeout failures are not mutation proof')
      assert.ok(evaluations.some(row => row.path === variant.file && row.mutation === label && row.originalSHA256 === inputs[row.path] && row.loadedSHA256 !== row.originalSHA256),
        'The bearing production mutation actually evaluated')
    } else {
      assert.equal(run.code, 0, run.log); assert.ok(tests.length >= 6); assert.equal(report.numFailedTests, 0); assert.equal(report.numPassedTests, tests.length)
      assert.ok(evaluations.every(row => row.loadedSHA256 === row.originalSHA256))
    }
    for (const [file, hash] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), hash, 'Task input unchanged: ' + file)
    receipt.runs.push({ label, exitCode: run.code, tests: tests.map(test => ({ name: test.fullName, status: test.status })), evaluations,
      reportSHA256: sha(await readFile(result)), logSHA256: sha(run.log) })
    process.stdout.write(JSON.stringify({ label, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
  }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: relative(root, resolve(directory, 'receipt.json')) }) + '\n')
