import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = resolve(root, '.local/state/mobile-mote-default-entry/verification')
mkdirSync(output, { recursive: true })
const config = 'apps/mobile/test/mobile-mote-default-entry.config.mts'
const cases = ['baseline', 'bottom-entry', 'row-entry', 'late-entry', 'exact-object']
const results = []
for (const name of cases) {
  const trace = resolve(output, name + '.ndjson'), report = resolve(output, name + '.json')
  writeFileSync(trace, '')
  const env = { ...process.env, AGENTMUX_TEST_MOTE_ENTRY_TRACE: trace }
  delete env.AGENTMUX_TEST_MOTE_ENTRY_MUTATION
  if (name !== 'baseline') env.AGENTMUX_TEST_MOTE_ENTRY_MUTATION = name
  const run = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile=' + report],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(resolve(output, name + '.log'), (run.stdout ?? '') + (run.stderr ?? ''))
  if (run.error) throw run.error
  const value = JSON.parse(readFileSync(report, 'utf8'))
  const markers = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const evaluated = markers.find(marker => marker.phase === 'evaluated' && marker.name === name)
  assert(evaluated, name + ': MobileApp must actually evaluate')
  if (results.length) assert.equal(evaluated.originalSha256, results[0].evaluated.originalSha256, name + ': production candidate changed during verification')
  assert(value.numTotalTests >= 10, name + ': the actual App assertions must run')
  const failures = value.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (name === 'baseline') {
    assert.equal(run.status, 0, 'baseline must pass')
    assert.equal(value.numFailedTests, 0)
    assert.equal(evaluated.originalSha256, evaluated.loadedSha256)
  } else {
    assert.notEqual(evaluated.originalSha256, evaluated.loadedSha256, name + ': loaded source must change')
    assert.notEqual(run.status, 0, name + ': broken production must fail')
    assert(failures.some(test => test.failureMessages.some(message => /AssertionError|expected/u.test(message))), name + ': assertion RED required, not import/build failure')
  }
  results.push({ name, status: name === 'baseline' ? 'green' : 'assertion-red', total: value.numTotalTests, passed: value.numPassedTests, failed: value.numFailedTests,
    evaluated, failingTests: failures.map(test => test.fullName), report, trace })
  console.log(name + ': ' + results.at(-1).status + ' (' + value.numPassedTests + '/' + value.numTotalTests + ' passed)')
}
const sources = ['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/navigation/MobileSpaceDirectory.tsx',
  'apps/mobile/test/mobile-mote-default-entry.test.tsx', config]
const receipt = { feature: 'f-3jf8fp8bb', task: 'T-003', result: 'passed', verifiedAt: new Date().toISOString(), root,
  scope: 'Actual MobileApp and maintained SDK/DeviceWorkface consumers with controlled original RPC/Runtime ports; no physical-phone or real Runtime recovery claim.',
  sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')])), results }
assert.equal(receipt.sourceSha256['apps/mobile/src/MobileApp.tsx'], results[0].evaluated.originalSha256, 'Production changed after the loaded-source checks')
writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log('Receipt: ' + resolve(output, 'receipt.json'))
