import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const evidence = join(dirname(common), '.local/reliability-fixes/desktop/recovery-notice')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const phases = []
function run(label, mutation, test, expected) {
  const resultPath = join(evidence, label + '.json'), sourcesPath = join(evidence, label + '.sources.ndjson')
  writeFileSync(sourcesPath, '', { mode: 0o600 })
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.storage-recovery-notice.config.mts',
    '--reporter=json', '--outputFile=' + resultPath, ...(test ? ['-t', test] : [])], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, AGENTMUX_RECOVERY_NOTICE_MUTATION: mutation ?? '', AGENTMUX_RECOVERY_NOTICE_LOADED: sourcesPath } })
  writeFileSync(join(evidence, label + '.log'), result.stdout + result.stderr, { mode: 0o600 })
  assert.equal(result.error, undefined, label + ': no setup timeout')
  const report = JSON.parse(readFileSync(resultPath, 'utf8'))
  const assertions = report.testResults.flatMap(file => file.assertionResults ?? []).filter(item => ['passed', 'failed'].includes(item.status))
  assert.ok(assertions.length, label + ': nonempty behavior cases')
  const failed = assertions.filter(item => item.status === 'failed')
  if (mutation) {
    assert.equal(result.status, 1)
    assert.ok(failed.some(item => item.fullName.includes(expected) && item.failureMessages.some(message =>
      /AssertionError/u.test(message) && !/timed out|Missing recovery-notice|Failed to resolve/u.test(message))), label + ': target behavior must kill mutation')
  } else { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(report.success, true); assert.equal(failed.length, 0) }
  const loaded = readFileSync(sourcesPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const path of ['apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx', 'apps/desktop/src/renderer/src/lib/use-storage-recovery-notice.ts'])
    assert.ok(loaded.some(item => item.absolutePath === join(root, path)), label + ': exact original consumer ' + path)
  if (mutation) assert.ok(loaded.some(item => item.mutation === mutation), label + ': exact mutation owner')
  phases.push({ label, mutation: mutation ?? null, passed: assertions.length - failed.length, failed: failed.length, exitCode: result.status })
  console.log(label + ': ' + (mutation ? 'target mutation killed' : 'passed'))
}
run('baseline')
run('disconnect-notice', 'disconnect-notice', 'real notice feed', 'real notice feed')
run('retry-new-target', 'retry-new-target', 'actual preload/Main/RuntimeController', 'actual preload/Main/RuntimeController')
run('lost-point', 'lost-point', 'previous original point', 'previous original point')
run('late-read', 'late-read', 'real notice feed', 'real notice feed')
run('restored')
writeFileSync(join(evidence, 'verification.json'), JSON.stringify({ schema: 'agentmux.storage-recovery-notice.v1', passed: true, root, phases,
  boundary: 'Real Renderer notice feed, typed preload, registered Main handler and RuntimeController original Host transport. Core exterior controlled; no production or user Runtime. Private screenshot evidence separately reviewed.' }, null, 2) + '\n', { mode: 0o600 })
