import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { discoveryMutations } from '../test/mobile-discovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.local/state/mobile-independent-host/discovery')
await mkdir(directory, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const runs = []
for (const label of ['baseline', ...Object.keys(discoveryMutations), 'restored']) {
  const mutant = Object.hasOwn(discoveryMutations, label), loaded = resolve(directory, label + '-loaded.jsonl'), result = resolve(directory, label + '-result.json'), facts = resolve(directory, label + '-facts.jsonl')
  await Promise.all([writeFile(loaded, ''), writeFile(facts, '')])
  const args = ['exec', 'vitest', 'run', '--config', 'apps/host/test/vitest.mobile-discovery.config.mts', '--reporter=json', '--outputFile=' + result]
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', args, { cwd: root, env: { ...process.env, HEADLESS_MOBILE_DISCOVERY_MUTANT: mutant ? label : '', HEADLESS_MOBILE_DISCOVERY_LOADED: loaded, HEADLESS_MOBILE_DISCOVERY_FACTS: facts }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ label, code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  assert.equal(run.signal, null, 'The test process must complete normally: ' + label)
  const report = JSON.parse(await readFile(result, 'utf8'))
  assert.equal(report.numTotalTests, 2, 'Both actual product and scoped cost consumers must execute')
  const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(evaluations.length > 0, 'An original owner must actually execute')
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutant) {
    assert.notEqual(run.code, 0, 'The actual implementation mutation must fail: ' + label)
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError') || message.includes('__VITEST_RESOLVES__'))), 'A consumer assertion must detect the mutation, not a loader failure: ' + label)
    assert.ok(evaluations.some(row => row.mutant === label && row.originalSHA256 !== row.loadedSHA256), 'The exact original implementation mutation must be evaluated: ' + label)
  } else {
    assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 2); assert.equal(failures.length, 0)
    const claims = (await readFile(facts, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.equal(claims.length, 1); assert.equal(claims[0].case, 'new-relay-after-desktop-exit')
    for (const fact of ['sameRuntime', 'sameSession', 'sameNative', 'sameRun']) assert.equal(claims[0][fact], true, fact)
    assert.equal(claims[0].originalName, 'Original named Agent'); assert.equal(claims[0].cliExitCode, 0)
  }
  runs.push({ label, exitCode: run.code, tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
    evaluations: [...new Map(evaluations.map(row => [JSON.stringify(row), row])).values()], resultSHA256: hash(await readFile(result)) })
  process.stdout.write(JSON.stringify({ label, exitCode: run.code, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
}
const inputs = {}
for (const path of new Set(runs.flatMap(run => run.evaluations.map(row => row.path)))) inputs[path] = hash(await readFile(resolve(root, path)))
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.headless-mobile-discovery.v1',
  scope: 'Isolated real ctxmux/Node Host/Main, original public RPC/CLI, existing and newly encrypted Relay Hosted consumers. Native CLI and presentation metadata are private fixtures; no live App or physical phone.', inputs, runs }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: true, receipt: '.local/state/mobile-independent-host/discovery/receipt.json' }) + '\n')
