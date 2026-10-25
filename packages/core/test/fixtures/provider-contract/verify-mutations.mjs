import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mutations } from './mutations.mjs'
const root = resolve(import.meta.dirname, '../../../../..')
const output = mkdtempSync(join(tmpdir(), 'provider-contract-mutations-'))
const registration = process.argv.includes('--registration')
const usage = process.argv.includes('--usage')
const settings = process.argv.includes('--settings')
const config = settings ? 'apps/desktop/test/provider-launch-settings.config.mts' : 'packages/core/test/fixtures/provider-contract/' + (registration ? 'vitest.registration.config.mts' : usage ? 'vitest.usage.config.mts' : 'vitest.config.mts')
try {
  for (const [name, mutation] of [['baseline', undefined], ...Object.entries(mutations).filter(([name]) => settings ? name.startsWith('settings-') : usage ? name.startsWith('usage-') : !registration || ['missing-resume-accepted', 'invalid-replacement-accepted', 'catalog-nested-alias'].includes(name))]) {
    const report = join(output, name + '.json'), receipt = join(output, name + '.jsonl')
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', mutation?.config ?? config, '--reporter=json', '--outputFile', report,
      ...(mutation ? ['--testNamePattern', mutation.test] : [])], { cwd: root, encoding: 'utf8',
      env: { ...process.env, ...(mutation ? { AMX_PROVIDER_MUTATION: name, AMX_PROVIDER_MUTATION_RECEIPT: receipt } : {}) } })
    const data = JSON.parse(readFileSync(report, 'utf8'))
    assert.ok(data.numTotalTests > 0, 'The selected source suite must execute tests')
    if (!mutation) {
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.equal(data.numFailedTests, 0)
    } else {
      const loaded = readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.ok(loaded.length > 0 && loaded.every(entry => entry.path === mutation.path && entry.source !== entry.loaded))
      const target = data.testResults.flatMap(file => file.assertionResults).filter(test => test.title === mutation.test)
      assert.equal(target.length, 1, 'The exact original oracle must execute')
      assert.equal(target[0].status, 'failed', result.stdout + result.stderr)
      assert.notEqual(result.status, 0)
    }
    console.log(JSON.stringify({ name, status: mutation ? 'killed' : 'passed', tests: data.numTotalTests, failures: data.numFailedTests }))
  }
} finally { rmSync(output, { recursive: true, force: true }) }
