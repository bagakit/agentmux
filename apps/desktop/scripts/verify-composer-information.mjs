import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const directory = mkdtempSync(join(tmpdir(), 'amx-composer-information-'))
const assertions = ['refreshes the open account face', 'places the actual action face', 'groups real Session controls']
try {
  function verify(name, filter, mutate = false) {
    const output = join(directory, `${name}.json`)
    const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config',
      'apps/desktop/test/agent-information-surface.config.mts', '-t', filter, '--reporter=json', '--outputFile', output], {
      cwd: root, encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, AMX_MUTATE_COMPOSER_INFORMATION: mutate ? '1' : '' }
    })
    if (run.error) throw run.error
    const report = JSON.parse(readFileSync(output, 'utf8'))
    const tests = report.testResults.flatMap(file => file.assertionResults)
    for (const prefix of assertions) assert.ok(tests.some(test => test.fullName.startsWith(prefix) &&
      (mutate ? test.status === 'failed' && test.failureMessages.some(error => error.includes('AssertionError')) : test.status === 'passed')), prefix)
    assert.equal(run.status, mutate ? 1 : 0, JSON.stringify(tests.filter(test => test.status === 'failed')))
    assert.equal(report.numFailedTests, mutate ? assertions.length : 0)
    console.log(JSON.stringify({ name, passed: report.numPassedTests, rejectedMutations: report.numFailedTests }))
  }
  // The status Prompt submission suite owns its own input admission fixture. Here we exercise the mounted disclosure and its surrounding controls.
  verify('baseline', '^(?!state Prompt actions mounted through the actual Session composer and Store)')
  verify('mutations', assertions.join('|'), true)
  verify('restored', assertions.join('|'))
} finally { rmSync(directory, { recursive: true, force: true }) }
