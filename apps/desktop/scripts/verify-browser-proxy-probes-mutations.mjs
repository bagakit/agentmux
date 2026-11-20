import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), directory = join(root, '.tmp/browser-proxy-probe-mutations')
await mkdir(directory, { recursive: true }); const out = await mkdtemp(join(directory, 'attempt-'))
const config = 'apps/desktop/scripts/fixtures/browser-proxy-probes/vitest.mutations.config.mts'
const main = 'apps/desktop/test/browser-proxy-probes.test.ts', ui = 'apps/desktop/test/browser-proxy-probes-ui.test.tsx', exit = 'apps/desktop/test/browser-profile-exit-check.test.ts'
const cases = [
  ['omit-webrtc-readback', main, 'observes real SOCKS authentication separately'],
  ['authentication-reply', main, 'does not certify authentication'], ['credential-generation', main, 'credential owner refuses an old configuration token'],
  ['configuration-token', main, 'observes real SOCKS authentication separately'], ['gui-dispatch', ui, 'shows separate protocol facts'], ['bounded-exit-body', exit, 'bounded prefix']
]
const receipt = { passed: false, sourceMutation: 'Private Vite transforms of actual production modules; checkout bytes are unchanged', runs: [], out }
async function run(name, files, target, mutation) {
  const reportFile = join(out, name + '.json'), loaded = join(out, name + '-loaded.ndjson')
  const env = { ...process.env, pnpm_config_verify_deps_before_run: 'false', ...(mutation ? { PROXY_PROBE_MUTATION: mutation, PROXY_PROBE_MUTATION_LOADED: loaded } : {}) }
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', config, ...files, ...(target ? ['-t', target] : []), '--reporter=json', '--outputFile', reportFile], { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
  await writeFile(join(out, name + '.log'), result.stdout + result.stderr)
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  assert.ok(report.numTotalTests > 0)
  assert.deepEqual(report.testResults.filter(suite => suite.status === 'failed' && !suite.assertionResults.some(test => test.status === 'failed')), [], 'No compilation/setup failure may count as a semantic RED')
  const executed = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'passed' || test.status === 'failed')
  assert.ok(executed.length > 0)
  const row = { name, status: result.status, passed: report.numPassedTests, failed: report.numFailedTests, executed: executed.map(test => ({ title: test.fullName, status: test.status })) }
  if (mutation) {
    assert.equal(result.status, 1); assert.ok(report.numFailedTests > 0)
    const actual = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(actual.length > 0 && actual.every(record => record.key === mutation && record.originalSha256 !== record.loadedSha256)); row.loaded = actual
    assert.ok(executed.some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError|expected|promise resolved|promise rejected/iu.test(message))), 'Business assertion must fail, not compilation/setup')
  } else { assert.equal(result.status, 0); assert.equal(report.numFailedTests, 0) }
  receipt.runs.push(row)
}
try {
  await run('baseline', [main, ui, exit])
  for (const [key, file, target] of cases) await run(key, [file], target, key)
  await run('restored', [main, ui, exit]); receipt.passed = true
} finally { await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') })) }
