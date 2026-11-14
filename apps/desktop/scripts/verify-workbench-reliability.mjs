import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export function verifyWorkbenchReliability(root, slice) {
  assert.ok(['input', 'spatial-window'].includes(slice))
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
  const evidence = process.env.AGENTMUX_RELIABILITY_EVIDENCE ?? join(dirname(common), '.local/reliability-fixes/desktop', slice)
  mkdirSync(evidence, { recursive: true, mode: 0o700 })
  const phases = []
  const config = 'apps/desktop/test/vitest.workbench-reliability.config.mts'
  function run(label, { mutation, test, selectedConfig = config, expectedFailure } = {}) {
    const output = join(evidence, label + '.json'), loaded = join(evidence, label + '.sources.ndjson')
    writeFileSync(loaded, '', { mode: 0o600 })
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', selectedConfig, '--reporter=json', '--outputFile=' + output]
    if (test) args.push('-t', test)
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, AGENTMUX_RELIABILITY_SLICE: slice, AGENTMUX_RELIABILITY_MUTATION: mutation ?? '', AGENTMUX_RELIABILITY_LOADED: loaded } })
    writeFileSync(join(evidence, label + '.log'), result.stdout + result.stderr, { mode: 0o600 })
    assert.equal(result.error, undefined, label + ': no timeout or process setup failure')
    const report = JSON.parse(readFileSync(output, 'utf8'))
    const assertions = report.testResults.flatMap(file => file.assertionResults ?? []).filter(item => item.status === 'passed' || item.status === 'failed')
    assert.ok(assertions.length > 0, label + ': nonempty actual behavioral collection')
    const failures = assertions.filter(item => item.status === 'failed')
    if (mutation) {
      assert.equal(result.status, 1, label + ': mutation must be killed')
      assert.ok(failures.some(item => item.fullName.includes(expectedFailure) && item.failureMessages.some(message =>
        /AssertionError|promise resolved .*instead of rejecting/u.test(message) && !/timed out|Missing reliability mutation|Failed to resolve/u.test(message))), label + ': a target behavior assertion kills the mutation')
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.equal(report.success, true); assert.equal(failures.length, 0)
    }
    if (selectedConfig !== config) {
      const sources = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      for (const path of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/workbench-user-state.ts', 'apps/desktop/src/preload/index.ts'])
        assert.ok(sources.some(source => source.path === path && source.absolutePath === join(root, path)), label + ': current native source consumer ' + path)
    }
    if (selectedConfig === config) {
      const sources = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      const owner = mutation ? sources.find(source => source.mutation === mutation) : sources.find(source => source.path === (slice === 'input'
        ? 'apps/desktop/src/main/workbench-user-state.ts' : 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts'))
      assert.ok(owner, label + ': actual production owner loaded')
      assert.ok(owner.absolutePath.startsWith(root + '/'), label + ': current worktree source, never shared old dist')
    }
    phases.push({ label, mutation: mutation ?? null, exitCode: result.status, passed: assertions.length - failures.length, failed: failures.length })
    process.stdout.write(label + ': ' + (mutation ? 'target mutation killed' : 'passed') + '\n')
  }
  run('baseline')
  if (slice === 'input') {
    run('native-preload-main', { selectedConfig: 'apps/desktop/test/vitest.workbench-user-ipc.config.mts' })
    run('late-admission', { mutation: 'late-admission', test: 'delayed pre-admission', expectedFailure: 'delayed pre-admission' })
    run('retry-disabled', { mutation: 'retry-disabled', test: 'autonomously retries', expectedFailure: 'autonomously retries' })
    run('late-ack', { mutation: 'late-ack', test: 'retires only the missing ACK', expectedFailure: 'retires only the missing ACK' })
    run('fenced-quit', { mutation: 'fenced-quit', test: 'fenced Quit keeps actual', expectedFailure: 'fenced Quit keeps actual' })
  } else {
    run('bootstrap-pending', { mutation: 'bootstrap-pending', test: 'bootstrap starts the original watchdog', expectedFailure: 'bootstrap starts the original watchdog' })
    run('checkpoints-serial', { mutation: 'checkpoints-serial', test: 'independent checkpoints save', expectedFailure: 'independent checkpoints save' })
    run('window-directory-ack', { mutation: 'window-directory-ack', test: 'requires a directory ACK', expectedFailure: 'requires a directory ACK' })
    run('window-quit', { mutation: 'window-quit', test: 'Quit preserves current windows', expectedFailure: 'Quit preserves current windows' })
  }
  run('restored')
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  const receipt = { schema: 'agentmux.workbench-reliability.v1', passed: true, root, slice, phases,
    invariants: { productionDataWritten: false, userRuntimeConnected: false, providerStarted: false,
      secondProcessReadsOriginalSavedFile: true, mutationSourceWritten: false },
    runnerSHA256: hash(join(root, 'apps/desktop/scripts/verify-workbench-reliability.mjs')) }
  writeFileSync(join(evidence, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  return receipt
}
