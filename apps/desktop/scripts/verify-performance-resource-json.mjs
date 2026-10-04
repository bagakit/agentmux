import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(process.env.AGENTMUX_METRICS_JSON_EVIDENCE_ROOT ?? resolve(root, '.local/state/performance-resource-json-acceptance'))
mkdirSync(evidence, { recursive: true })
rmSync(resolve(evidence, 'acceptance.json'), { force: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', ...env } })
if (!process.env.AGENTMUX_METRICS_JSON_SKIP_BUILD) {
  const build = run(['packages/core/scripts/build.mjs'])
  writeFileSync(resolve(evidence, 'core-build.log'), build.stdout + build.stderr)
  assert.equal(build.signal, null, 'Build may not be terminated')
  assert.ok(Number.isInteger(build.status), 'Build must complete')
  assert.equal(build.status, 0, 'Normal Core build required; see core-build.log')
}
assert.ok(existsSync(resolve(root, 'packages/core/dist/agentmux.js')), 'Actual compiled public CLI required')
const config = 'apps/desktop/scripts/fixtures/performance-resource-json/vitest.config.mts'
const mutants = ['snapshot-depth', 'result-depth', 'metrics-schema', 'record-prototype', 'record-keys', 'record-descriptor', 'array-prototype', 'array-keys', 'array-descriptor', 'byte-budget']
const results = []
for (const mutant of ['baseline', ...mutants]) {
  const folder = resolve(evidence, mutant); mkdirSync(folder, { recursive: true })
  const output = resolve(folder, 'tests.json')
  rmSync(output, { force: true }); rmSync(resolve(folder, 'loaded-source.jsonl'), { force: true })
  const test = run(['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile', output],
    { AGENTMUX_METRICS_JSON_MUTANT: mutant, AGENTMUX_METRICS_JSON_EVIDENCE: folder })
  writeFileSync(resolve(folder, 'run.log'), test.stdout + test.stderr)
  assert.equal(test.signal, null, 'Test may not be terminated: ' + mutant)
  assert.ok(Number.isInteger(test.status), 'Test must complete: ' + mutant)
  assert.ok(existsSync(output), 'No test receipt: ' + mutant)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.numPendingTests, 0, 'Pending tests cannot count as acceptance')
  assert.equal(report.numTodoTests, 0, 'Todo tests cannot count as acceptance')
  assert.equal(report.numPassedTests + report.numFailedTests, 24, 'All behavior tests must actually run')
  assert.ok(report.numTotalTests >= 24, 'Empty or incomplete behavior suite: ' + mutant)
  const loaded = readFileSync(resolve(folder, 'loaded-source.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(loaded.some(row => row.path === 'packages/core/src/toolkit.ts'), 'Actual owning source not consumed')
  const failed = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  if (mutant === 'baseline') { assert.equal(test.status, 0, 'Baseline failed'); assert.equal(failed.length, 0) }
  else {
    assert.notEqual(test.status, 0, 'Surviving production mutant: ' + mutant)
    assert.ok(loaded.some(row => row.sourceSHA256 !== row.consumedSHA256), 'Empty source mutant: ' + mutant)
    assert.ok(failed.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Mutation must fail a behavior assertion: ' + mutant)
  }
  results.push({ mutant, exitCode: test.status, tests: report.numTotalTests, failed: failed.map(test => test.fullName) })
  process.stdout.write(mutant + ': ' + (mutant === 'baseline' ? 'PASS' : 'ASSERTION_RED') + '\n')
}
const callers = [
  ['packages/core/src/control-codec.ts', 'parseToolkitResult('],
  ['packages/core/src/public-rpc-client.ts', 'parseToolkitSnapshot('],
  ['apps/desktop/src/main/toolkit-ipc.ts', 'parseToolkitSnapshot('],
  ['apps/desktop/src/main/toolkit-ipc.ts', 'parseToolkitResult(']
].map(([path, symbol]) => {
  const source = readFileSync(resolve(root, path), 'utf8')
  assert.ok(source.includes(symbol), 'Nonempty external production consumer required: ' + path)
  return { path, symbol, sourceSHA256: sha(source) }
})
const sources = ['packages/core/src/toolkit.ts', 'packages/core/src/metrics.ts', 'packages/core/src/settings-resource-json.ts']
  .map(path => ({ path, sourceSHA256: sha(readFileSync(resolve(root, path))) }))
writeFileSync(resolve(evidence, 'acceptance.json'), JSON.stringify({ schema: 'agentmux.performance-resource-json-acceptance.v1',
  status: 'passed', sources, callers, results, cliSHA256: sha(readFileSync(resolve(root, 'packages/core/dist/agentmux.js'))),
  limits: 'Source/public transport acceptance; running Desktop update is a separate fact. No Run or persisted user data modified.' }, null, 2) + '\n')
