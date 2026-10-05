import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { provePerformanceOwner, proofRoot as root, sha } from './performance-owner-proof.mjs'

const main = 'apps/desktop/src/main/performance-diagnostics.ts'
const metrics = 'packages/core/src/metrics.ts'
const focused = 'apps/desktop/test/performance-source-isolation.test.ts'
const related = 'apps/desktop/test/main-performance-diagnostics.test.ts'
const config = 'apps/desktop/test/performance-source-isolation.vitest.mts'
const tests = [focused, related]
const inputs = [import.meta.filename, ...[main, metrics, ...tests, config,
  'apps/desktop/test/performance-source-isolation.tsconfig.json',
  'apps/desktop/scripts/performance-owner-proof.mjs', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json',
  'packages/core/src/control.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/control-host.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/toolkit.ts',
  'packages/core/src/performance-diagnostics.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'packages/core/test/helpers/toolkit-metrics.ts', 'packages/core/test/helpers/renderer-performance.ts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts',
  'packages/core/bin/amux', 'packages/core/dist/agentmux.js', 'packages/core/dist/metrics.js',
  'packages/core/dist/control.js', 'packages/core/dist/control-codec.js', 'packages/core/dist/toolkit.js',
  'packages/core/dist/public-rpc-service.js', 'packages/core/dist/public-rpc-client.js'
].map(path => join(root, path))]
const mutants = [
  ['host-validation-removed', main, '.then(parseClientPerformanceDiagnostics)', ''],
  ['core-source-parser-bypassed', metrics,
    '  clientPerformanceParser(value)\n  return value as ClientPerformanceDiagnostics',
    '  return value as ClientPerformanceDiagnostics'],
  ['all-healthy-host-facts-dropped', main, 'hosts: hostFacts,', 'hosts: [],'],
  ['source-error-unbounded', main, 'String(error).slice(0, 4096)', 'String(error)'],
  ['settled-host-never-released', main, '() => this.hosts.delete(client)', '() => {}']
]
const directory = join(root, '.local/state/performance-source-isolation')
mkdirSync(directory, { recursive: true })
const locator = join(directory, 'qualification.json')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const hashes = () => Object.fromEntries(inputs.map(path => [path, sha(readFileSync(path))]))
function command(name, args) {
  const child = spawnSync('pnpm', args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: '' },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  const log = join(directory, name + '.log')
  writeFileSync(log, (child.stdout ?? '') + (child.stderr ?? ''))
  assert.equal(child.error, undefined); assert.equal(child.signal, null)
  assert.equal(child.status, 0, `${name} failed: ${log}`)
  return { exitCode: child.status, log, sha256: sha(readFileSync(log)) }
}
function validate(saved) {
  assert.equal(saved.passed, true)
  assert.deepEqual(saved.driverInputs.before, hashes()); assert.deepEqual(saved.driverInputs.after, hashes())
  assert.deepEqual(saved.mutants, mutants)
  for (const [path, digest] of Object.entries(saved.rawFiles)) assert.equal(sha(readFileSync(path)), digest, path)
  for (const entry of Object.values(saved.types)) assert.equal(entry.exitCode, 0)
  const normalDefault = json(saved.defaultReport), receipt = json(saved.ownerReceipt)
  assert.equal(normalDefault.numTotalTests, 12); assert.equal(normalDefault.numPassedTests, 12)
  assert.equal(normalDefault.numFailedTests, 0); assert.equal(normalDefault.numPendingTests, 0); assert.equal(normalDefault.numTodoTests, 0)
  assert.equal(receipt.passed, true)
  assert.equal(receipt.verifierSHA256, saved.driverInputs.before[import.meta.filename])
  assert.deepEqual(receipt.runs.map(row => row.name), ['normal', ...mutants.map(row => row[0])])
  for (const run of receipt.runs) {
    const report = json(join(saved.ownerDirectory, run.name + '.json'))
    assert.equal(report.numTotalTests, 12); assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0)
    if (run.name === 'normal') {
      assert.equal(report.numPassedTests, 12); assert.equal(report.numFailedTests, 0)
      for (const owner of [main, metrics]) assert.equal(run.loadedSources[join(root, owner)], saved.driverInputs.before[join(root, owner)])
    } else {
      const [, owner, before, after] = mutants.find(row => row[0] === run.name)
      assert.equal(run.loadedSources[join(root, owner)], sha(readFileSync(join(root, owner), 'utf8').replace(before, after)))
      assert.ok(report.testResults.flatMap(suite => suite.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError/u.test(message))))
    }
  }
  assert.deepEqual(saved.executionEvidence.map(row => row.variant).sort(), ['extra-field', 'missing-field'])
  for (const row of saved.executionEvidence) {
    assert.equal(row.userRunTouched, false); assert.equal(row.actualHostReads, 2)
    assert.deepEqual(row.metrics.result.observation, row.unixMetrics.observation)
    assert.deepEqual(row.toolkit.result.snapshot, row.unixToolkit.snapshot)
    const diagnostics = row.metrics.result.observation.diagnostics.data
    assert.equal(diagnostics.main.processId, 100); assert.equal(diagnostics.hosts.length, 2)
    assert.equal(diagnostics.hosts[0].data, null); assert.ok(diagnostics.hosts[0].unavailable)
    assert.equal(diagnostics.hosts[1].data.processId, 300); assert.equal(diagnostics.hosts[1].unavailable, null)
  }
}
if (existsSync(locator)) {
  const saved = json(locator); validate(saved)
  process.stdout.write(JSON.stringify({ passed: true, exactEvidenceReused: true, defaultNormal: 12, normal: 12, mutants: 5, receipt: locator }) + '\n')
} else {
  const before = hashes(), stamp = Date.now()
  const types = { desktop: command('desktop-types-' + stamp, ['exec', 'tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json']),
    focused: command('focused-types-' + stamp, ['exec', 'tsc', '--noEmit', '-p', 'apps/desktop/test/performance-source-isolation.tsconfig.json']) }
  const defaultReport = join(directory, 'default-normal-' + stamp + '.json')
  const normalDefault = command('default-normal-' + stamp, ['exec', 'vitest', 'run', ...tests, '--reporter=json', '--outputFile', defaultReport])
  const proof = provePerformanceOwner({ name: 'performance-source-isolation', config, owners: [main, metrics],
    tests, minimumTests: 12, mutantTests: tests, mutants, callers: [
      [main, '.then(parseClientPerformanceDiagnostics)'],
      ['apps/desktop/src/main/runtime-controller.ts', 'this.performanceObservation.observe('],
      ['packages/core/src/control.ts', "export * from './metrics.js'"],
      ['packages/core/src/metrics.ts', 'data: nullable(clientPerformanceParser)']
    ] })
  const executionPath = join(proof.directory, 'normal.ast-loaded.jsonl.source-isolation')
  const executionEvidence = readFileSync(executionPath, 'utf8').trim().split('\n').map(JSON.parse)
  const after = hashes(); assert.deepEqual(after, before)
  const raw = [...readdirSync(proof.directory).map(file => join(proof.directory, file)), defaultReport, normalDefault.log,
    ...Object.values(types).map(entry => entry.log)]
  const saved = { passed: true, root, driverInputs: { before, after }, mutants, types, defaultReport, normalDefault,
    ownerDirectory: proof.directory, ownerReceipt: join(proof.directory, 'receipt.json'), executionEvidence,
    rawFiles: Object.fromEntries(raw.map(path => [path, sha(readFileSync(path))])),
    boundary: 'Actual Main source read boundary, original strict Core parser, default built package and controlled private Unix Metrics/watch/compiled CLI/typed Toolkit. Exact source parser alias in mutation config; no copied implementation. No user Run/UI/input, native Runtime, restart or installation qualification.' }
  validate(saved); writeFileSync(locator, JSON.stringify(saved, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, defaultNormal: 12, normal: 12, mutants: 5, receipt: locator }) + '\n')
}
