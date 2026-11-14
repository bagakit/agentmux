import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { mobileBrandMutations, mobileBrandOwners } from '../test/mobile-brand-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const directory = resolve(root, '.local/state/mobile-brand', 'run-' + randomUUID())
const sourceFiles = [...mobileBrandOwners, 'apps/mobile/test/mobile-brand-mutant.config.ts',
  'apps/mobile/test/mobile-brand-mutations.mjs', 'apps/mobile/scripts/verify-mobile-brand.mjs']
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const receipt = { schema: 'agentmux.mobile-brand.v1', passed: false, inputs, runs: [],
  scope: 'Actual MobileApp Goals consumers use the strict public RPC service, original Host Goal domain and durable DemandStore. Native discussion execution is controlled by the existing owner fixture. Loaded source mutations bear on art visibility, form disclosure and the exact discussion target; real-browser geometry and independent visual review remain separate.' }
await mkdir(directory, { recursive: true })
try {
  for (const label of ['baseline', ...Object.keys(mobileBrandMutations), 'restored']) {
    const variant = mobileBrandMutations[label], loaded = resolve(directory, label + '-loaded.jsonl'), result = resolve(directory, label + '-result.json')
    await writeFile(loaded, '')
    const env = { ...process.env, VITEST_MAX_THREADS: '2', VITEST_MAX_FORKS: '2', MOBILE_BRAND_LOADED: loaded }
    delete env.MOBILE_BRAND_MUTATION
    if (variant) env.MOBILE_BRAND_MUTATION = label
    const run = await new Promise((accept, reject) => {
      const child = spawn('pnpm', ['--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', '--config', 'test/mobile-brand-mutant.config.ts', '--reporter=json', '--outputFile=' + result], { cwd: mobile, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log }))
    })
    await writeFile(resolve(directory, label + '.log'), run.log)
    assert.equal(run.signal, null)
    const report = JSON.parse(await readFile(result, 'utf8'))
    const tests = report.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
    for (const file of mobileBrandOwners) assert.ok(evaluations.some(row => row.path === file), 'Real owner and consumer must load: ' + file)
    if (variant) {
      assert.notEqual(run.code, 0, 'Mutated production behavior must fail its bearing test')
      assert.equal(tests.length, 1, 'Exactly the bearing test runs'); assert.equal(report.numFailedTests, 1); assert.equal(report.numPassedTests, 0)
      assert.ok(tests[0].fullName.includes(variant.target))
      assert.ok(tests[0].failureMessages.some(message => message.includes('AssertionError')), 'Import, setup and timeout failures are not mutation proof')
      assert.ok(evaluations.some(row => row.path === variant.file && row.mutation === label && row.originalSHA256 === inputs[row.path] && row.loadedSHA256 !== row.originalSHA256), 'The bearing production mutation actually evaluated')
    } else {
      assert.equal(run.code, 0, run.log); assert.equal(tests.length, 3); assert.equal(report.numFailedTests, 0); assert.equal(report.numPassedTests, tests.length)
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
