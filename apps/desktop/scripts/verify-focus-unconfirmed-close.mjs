import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), temporary = mkdtempSync(join(tmpdir(), 'source-close-proof-'))
const scenarios = ['Source carrier closes one original occurrence', 'stale Source split', 'Source close plan reviews original', 'actual Source', 'local close rejects', 'retained Source buffer', 'lost original close ACK', 'obtained original close ACK']
const mutationScenarios = { 'first-position': 'actual Source focus-menu', 'recovered-member': 'actual Source changed-agent', 'region-scope': 'stale Source split', 'original-draft': 'Source close plan reviews original' }
const targets = ['apps/desktop/src/main/source-workbench-close.ts', 'apps/desktop/src/renderer/src/hooks/useSourceWorkbenchClose.tsx', 'apps/desktop/src/renderer/src/lib/workbench-close-owner.ts']
try {
  for (const [index, mutation] of [null, ...Object.keys(mutationScenarios), null].entries()) {
    const loaded = join(temporary, `loaded-${index}.jsonl`), output = join(temporary, `tests-${index}.json`)
    const env = { ...process.env, AGENTMUX_WORKBENCH_CLOSE_NATIVE: '1', AGENTMUX_SOURCE_CLOSE_LOADED: loaded }
    delete env.AGENTMUX_WORKBENCH_CLOSE_RESTART
    if (mutation) env.AGENTMUX_SOURCE_CLOSE_MUTATION = mutation
    else delete env.AGENTMUX_SOURCE_CLOSE_MUTATION
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/vitest.focus-unconfirmed-close.config.mts', '-t', mutation ? mutationScenarios[mutation] : scenarios.join('|'), '--testTimeout=90000', '--reporter=json', '--outputFile', output], { cwd: root, env, encoding: 'utf8' })
    assert.ok(!run.error && run.status !== null, `Actual consumer process completed: ${run.error ?? run.signal}`)
    const report = JSON.parse(readFileSync(output, 'utf8')), tests = report.testResults.flatMap(result => result.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
    const sources = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok((mutation ? [targets.find(target => sources.some(source => source.path === target && source.mutation === mutation))] : targets).every(target => target && sources.some(source => source.path === target)), 'Original Main, Renderer controller and original draft owner loaded')
    if (mutation) {
      assert.notEqual(run.status, 0, 'Mutated actual consumer fails')
      assert.ok(tests.some(test => test.fullName.includes(mutationScenarios[mutation]) && test.status === 'failed' && test.failureMessages.some(message => /AssertionError|expected/.test(message))), 'The selected business assertion catches the changed behavior')
      assert.ok(sources.some(source => source.mutation === mutation && source.loadedSHA256 !== source.originalSHA256), 'Changed production source actually loaded')
    } else {
      assert.equal(run.status, 0, tests.filter(test => test.status === 'failed').map(test => test.fullName + '\n' + test.failureMessages.join('\n')).join('\n') + run.stdout + run.stderr)
      assert.ok(scenarios.every(scenario => tests.some(test => test.fullName.includes(scenario) && test.status === 'passed')), 'Every nonempty original Source scenario ran')
      assert.ok(tests.length >= scenarios.length && tests.every(test => test.status === 'passed'), 'All selected consumer cases passed: ' + JSON.stringify(tests.map(test => ({ name: test.fullName, status: test.status }))))
      assert.ok(sources.every(source => source.loadedSHA256 === source.originalSHA256), 'Unchanged production sources loaded')
    }
    console.log(`${mutation ?? 'original'}: ${mutation ? 'detected' : 'passed'}`)
  }
  const restart = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/vitest.workbench-close.config.mts', '-t', 'an applied Source close survives', '--reporter=json', '--outputFile', join(temporary, 'restart.json')], { cwd: root, env: { ...process.env, AGENTMUX_WORKBENCH_CLOSE_NATIVE: '0' }, encoding: 'utf8' })
  assert.equal(restart.status, 0, restart.stdout + restart.stderr)
  const restarted = JSON.parse(readFileSync(join(temporary, 'restart.json'), 'utf8'))
  assert.ok(restarted.testResults.flatMap(result => result.assertionResults).some(test => test.fullName.includes('an applied Source close survives') && test.status === 'passed'), 'Two actual original owner process restarts ran')
  console.log('original owner restarts: passed')
} finally { rmSync(temporary, { recursive: true, force: true }) }
