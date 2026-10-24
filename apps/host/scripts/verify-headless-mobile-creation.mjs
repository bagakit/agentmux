import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { creationMutations } from '../test/mobile-creation-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.local/state/mobile-independent-host/creation')
await mkdir(directory, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex'), runs = []
function verifySourceConditions({ inputs, runs }) {
  // Host composition also records unrelated Goal wiring. Preserve those exact
  // per-run observations without requiring that business owner to stop editing.
  const paths = Object.keys(inputs).filter(path => path !== 'apps/host/src/host.ts')
  for (const path of paths) {
    const observations = runs.flatMap(run => run.evaluations.filter(row => row.path === path))
    assert.ok(observations.length && observations.every(row => row.originalSHA256 === inputs[path]),
      'The evaluated creation source must remain one candidate through the final snapshot: ' + path)
  }
  return { paths, sharedObservations: ['apps/host/src/host.ts'] }
}
if (process.argv[2] === '--verify-receipt') {
  const receipt = JSON.parse(await readFile(resolve(directory, 'receipt.json'), 'utf8'))
  process.stdout.write(JSON.stringify({ verified: true, sourceConditions: verifySourceConditions(receipt) }) + '\n')
  process.exit(0)
}
const harnessPaths = ['apps/host/scripts/verify-headless-mobile-creation.mjs', 'apps/host/test/mobile-desktop-creation.test.tsx',
  'apps/host/test/mobile-creation-mutations.mjs', 'apps/host/test/vitest.mobile-creation.config.mts', 'apps/host/test/mobile-web-node-loader.mjs',
  'apps/host/test/helpers/mobile-web-fixture.ts', 'apps/host/test/fixtures/mobile-web-main.mjs']
for (const label of ['baseline', ...Object.keys(creationMutations), 'restored']) {
  const mutant = Object.hasOwn(creationMutations, label), loaded = resolve(directory, label + '-loaded.jsonl'), result = resolve(directory, label + '-result.json')
  const sourceAdmission = label === 'creation-session' || label === 'creation-admission-device'
  const harnessInputs = Object.fromEntries(await Promise.all(harnessPaths.map(async path => [path, hash(await readFile(resolve(root, path)))])))
  await writeFile(loaded, '')
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/host/test/vitest.mobile-creation.config.mts', '--reporter=json', '--outputFile=' + result,
      ...(sourceAdmission ? ['-t', 'a revoked original device fence'] : [])], {
      cwd: root, env: { ...process.env, HEADLESS_MOBILE_CREATION_MUTANT: mutant ? label : '', HEADLESS_MOBILE_CREATION_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ label, code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  assert.equal(run.signal, null)
  const report = JSON.parse(await readFile(result, 'utf8')), evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(report.numTotalTests, 3, 'The actual creation suite must be collected')
  assert.equal(report.numPassedTests + report.numFailedTests, sourceAdmission ? 1 : 3, 'The selected original contract must execute')
  for (const path of [...(sourceAdmission ? [] : ['apps/mobile/src/navigation/MobileAgentCreate.tsx']), 'apps/host/src/spatial-agent-control.ts', 'packages/core/src/spatial-agent-open.ts', 'packages/core/src/spatial-state.ts']) assert.ok(evaluations.some(row => row.path === path), 'The original consumer and owner must actually evaluate: ' + path)
  const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutant) {
    assert.notEqual(run.code, 0, 'The implementation mutation must fail: ' + label)
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError') || /__VITEST_(?:RESOLVES|REJECTS)__/u.test(message))), 'A consumer assertion must detect the mutation: ' + label)
    assert.ok(evaluations.some(row => row.mutant === label && row.originalSHA256 !== row.loadedSHA256), 'The exact original mutation must evaluate: ' + label)
  } else { assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, 3); assert.equal(failures.length, 0) }
  runs.push({ label, exitCode: run.code, tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests, harnessInputs,
    evaluations: [...new Map(evaluations.map(row => [JSON.stringify(row), row])).values()], resultSHA256: hash(await readFile(result)) })
  process.stdout.write(JSON.stringify({ label, exitCode: run.code, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
}
const inputs = {}
for (const path of new Set(runs.flatMap(run => run.evaluations.map(row => row.path)))) inputs[path] = hash(await readFile(resolve(root, path)))
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.headless-mobile-creation.v1',
  scope: 'Baseline/restored and product mutations use isolated real ctxmux/Node Host/Main with the actual Relay Hosted connector and MobileAgentCreate form. Covers original newTab/launcher creation, first input, exact receipts, Host restart, stale Desktop graph retention and configuration. Session/admission-device mutations execute only the original locked spatial admission/device contract. Foreign routing covers the original public owners, not a remote process or new Hosted SDK federation. DOM storage uses the existing IDB test seam; no native browser IndexedDB, live App, physical phone or package qualification.',
  environment: { node: process.versions.node, platform: process.platform, architecture: process.arch }, sourceConditions: verifySourceConditions({ inputs, runs }), inputs, runs }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: true, receipt: '.local/state/mobile-independent-host/creation/receipt.json' }) + '\n')
