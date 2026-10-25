import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, '.tmp/launcher-spatial-ack-verification')
mkdirSync(output, { recursive: true })
const files = ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
  'apps/desktop/test/launcher-spatial-ack.test.ts', 'apps/desktop/test/desktop-spatial-latest-intent.test.ts',
  'apps/desktop/test/vitest.launcher-spatial-ack.config.mts']
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')]))
const before = hashes(), results = []
for (const mutation of ['drop-pending', 'borrow-incoming', 'none']) {
  const report = resolve(output, mutation + '.json')
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/vitest.launcher-spatial-ack.config.mts',
    '--reporter=json', '--outputFile=' + report], {
    cwd: root, env: { ...process.env, AGENTMUX_SPATIAL_TEST_MUTATION: mutation }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024
  })
  writeFileSync(resolve(output, mutation + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.ifError(result.error)
  const actual = JSON.parse(readFileSync(report, 'utf8'))
  assert.ok(actual.numTotalTests >= 23, 'Both original nonempty behavior suites must execute')
  const failures = actual.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName))
  if (mutation === 'none') {
    assert.equal(result.status, 0, 'The restored production candidate must pass')
    assert.equal(actual.numFailedTests, 0)
  } else {
    assert.notEqual(result.status, 0, 'A loaded production mutation must fail')
    assert.ok(failures.some(name => name.includes(mutation === 'drop-pending'
      ? 'keeps the original pending Region across save-ack'
      : 'applies an explicit launcher-target replacement')), 'The mutation must fail its intended behavior assertion')
  }
  results.push({ mutation, exitCode: result.status, total: actual.numTotalTests, failed: actual.numFailedTests, failures })
}
assert.deepEqual(hashes(), before, 'Verification must not edit the shared production candidate')
writeFileSync(resolve(output, 'receipt.json'), JSON.stringify({ files: before, results }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt: resolve(output, 'receipt.json'), results }, null, 2))
