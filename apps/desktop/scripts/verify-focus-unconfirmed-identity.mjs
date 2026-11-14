import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const temporary = mkdtempSync(join(tmpdir(), 'focus-identity-proof-'))
const targets = ['apps/desktop/src/renderer/src/lib/focus-source-model.ts', 'apps/desktop/src/renderer/src/lib/use-focus-sources.tsx']
const name = 'legacy unknown original member'
try {
  for (const [index, mutation] of [null, 'unconfirmed-name', 'unconfirmed-position', null].entries()) {
    const loaded = join(temporary, `loaded-${index}.jsonl`)
    const reportFile = join(temporary, `result-${index}.json`)
    const env = { ...process.env, AGENTMUX_FOCUS_SOURCE_LOADED: loaded }
    if (mutation) env.AGENTMUX_FOCUS_SOURCE_MUTATION = mutation
    else delete env.AGENTMUX_FOCUS_SOURCE_MUTATION
    const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/vitest.focus-source-unification.config.mts', '--maxWorkers=1', '--reporter=json', '--outputFile', reportFile]
    if (mutation) args.push('-t', name)
    const run = spawnSync('pnpm', args, { cwd: root, env, encoding: 'utf8' })
    const output = run.stdout + run.stderr
    assert.ok(!run.error && run.status !== null, `Test process completed: ${run.error ?? run.signal}`)
    const sources = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(item => targets.includes(item.path))
    assert.ok(targets.every(target => sources.some(item => item.path === target)), 'Both actual Focus sources were loaded')
    const report = JSON.parse(readFileSync(reportFile, 'utf8'))
    const original = report.testResults.flatMap(result => result.assertionResults).find(test => test.fullName.includes(name))
    assert.ok(original, 'The original identity scenario actually ran')
    if (mutation) {
      assert.notEqual(run.status, 0, 'The changed production source must fail')
      assert.equal(original.status, 'failed', 'The original scenario detected the changed behavior')
      assert.match(original.failureMessages.join('\n'), mutation === 'unconfirmed-name' ? /Agent · same-original-sid/ : /Position unknown-original-position/, 'The original identity or position assertion must catch the changed source')
      assert.ok(sources.some(item => item.mutation === mutation && item.loadedSHA256 !== item.originalSHA256), 'The actual changed source was loaded')
    } else {
      assert.equal(run.status, 0, output)
      assert.ok(report.numTotalTests > 0 && report.numPassedTests === report.numTotalTests, 'The complete source consumer suite actually ran')
      assert.equal(original.status, 'passed', 'The original identity scenario passed')
      assert.ok(sources.every(item => item.loadedSHA256 === item.originalSHA256), 'The original source was loaded')
    }
    console.log(`${mutation ?? 'original'}: ${mutation ? 'detected' : 'passed'}`)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
