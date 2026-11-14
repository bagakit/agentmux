import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostedSummaryMutations, hostedSummaryTests } from './hosted-summary-mutations.mjs'

export async function verifyHostedSummaryMutations(kinds = ['core', 'mobile']) {
for (const kind of kinds) assert.ok(Object.hasOwn(hostedSummaryTests, kind), 'Choose an existing bearing suite')
const root = resolve(import.meta.dirname, '../../..'), output = resolve(root, '.local/state/hosted-summary', 'run-' + randomUUID())
await mkdir(output, { recursive: true })
const files = ['packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-session-summary.ts',
  'packages/core/src/agent-prompt-condition.ts', 'packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-value.ts',
  'packages/core/src/hosted.ts', 'packages/core/src/relay-hosted.ts', 'apps/mobile/src/connection/MobileConnectionRoot.tsx',
  'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', ...Object.values(hostedSummaryTests),
  'apps/mobile/test/hosted-summary-mutant.config.ts', 'packages/core/test/hosted-summary-mutations.mjs', 'packages/core/test/verify-hosted-summary-mutations.mjs']
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = Object.fromEntries(await Promise.all(files.map(async path => [path, sha(await readFile(resolve(root, path)))])))
const receipt = { schema: 'agentmux.hosted-session-summary-mutations.v1', passed: false, inputs, runs: [] }
try {
  const cases = [ ...kinds.map(kind => ['baseline-' + kind, kind]),
    ...Object.entries(hostedSummaryMutations).filter(([, value]) => kinds.includes(value.kind)).map(([id, value]) => [id, value.kind]),
    ...kinds.map(kind => ['restored-' + kind, kind]) ]
  for (const [label, kind] of cases) {
    const variant = hostedSummaryMutations[label], loaded = resolve(output, label + '-loaded.jsonl'), reportPath = resolve(output, label + '-result.json')
    await writeFile(loaded, '')
    const env = { ...process.env, VITEST_MAX_THREADS: '2', VITEST_MAX_FORKS: '2', HOSTED_SUMMARY_TEST_KIND: kind,
      HOSTED_SUMMARY_LOADED: loaded, HOSTED_SUMMARY_MEASUREMENTS: resolve(output, label + '-measurements.jsonl') }; delete env.HOSTED_SUMMARY_MUTATION
    if (variant) env.HOSTED_SUMMARY_MUTATION = label
    const run = await new Promise((accept, reject) => {
      const child = spawn('pnpm', ['--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', '--config', 'test/hosted-summary-mutant.config.ts', '--reporter=json', '--outputFile=' + reportPath],
        { cwd: resolve(root, 'apps/mobile'), env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log }))
    })
    await writeFile(resolve(output, label + '.log'), run.log)
    assert.equal(run.signal, null)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    const tests = report.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value)).filter(value => value.phase === 'evaluated')
    const owners = kind === 'core' ? ['packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-session-summary.ts', 'packages/core/src/agent-prompt-condition.ts']
      : kind === 'cost' ? ['packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts'] : ['apps/mobile/src/conversation/use-mobile-prompt-controller.ts']
    for (const path of [hostedSummaryTests[kind], ...owners]) assert.ok(evaluations.some(value => value.path === path), 'The real owner and bearing consumer must load: ' + path)
    if (variant) {
      assert.notEqual(run.code, 0); assert.equal(tests.length, 1); assert.equal(report.numFailedTests, 1); assert.equal(report.numPassedTests, 0)
      assert.ok(tests[0].fullName.includes(variant.target))
      assert.ok(tests[0].failureMessages.some(message => message.includes('AssertionError')), 'Import and timeout failures are not mutation proof')
      assert.ok(evaluations.some(value => value.path === variant.file && value.mutation === label && value.originalSHA256 === inputs[value.path] && value.loadedSHA256 !== value.originalSHA256), 'The production mutation must actually evaluate')
    } else {
      assert.equal(run.code, 0, run.log); assert.ok(tests.length > 0); assert.equal(report.numFailedTests, 0); assert.equal(report.numPassedTests, tests.length)
      assert.ok(evaluations.every(value => value.originalSHA256 === value.loadedSHA256))
    }
    for (const [path, hash] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, path))), hash, 'Task inputs remain unchanged: ' + path)
    receipt.runs.push({ label, code: run.code, tests: tests.map(value => ({ name: value.fullName, status: value.status })), evaluations })
    process.stdout.write(JSON.stringify({ label, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
  }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: relative(root, resolve(output, 'receipt.json')) }) + '\n')
return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyHostedSummaryMutations()
