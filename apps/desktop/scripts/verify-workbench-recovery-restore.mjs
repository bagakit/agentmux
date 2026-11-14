import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_DESKTOP_RESTORE_EVIDENCE
assert.ok(evidence, 'An exact private evidence directory is required')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const phases = []
for (const [label, selected] of [
  ['baseline'], ['queue-auto-replay', 'restores the original native document'], ['replace-live-draft', 'retains an open document'],
  ['close-auto-apply', 'complete Close cohort'], ['source-wrong-target', 'returns exact unavailable'], ['restored']
]) {
  const mutation = selected ? label : '', output = join(evidence, label + '.json'), sources = join(evidence, label + '.sources.ndjson')
  writeFileSync(sources, '', { mode: 0o600 })
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/test/vitest.workbench-recovery-restore.config.mts', '--reporter=json', '--outputFile=' + output, ...(selected ? ['-t', selected] : [])],
    { cwd: root, encoding: 'utf8', timeout: 90_000, env: { ...process.env, AGENTMUX_DESKTOP_RESTORE_MUTATION: mutation, AGENTMUX_SOURCE_EXPORT_LOADED: sources } })
  writeFileSync(join(evidence, label + '.log'), result.stdout + result.stderr, { mode: 0o600 })
  assert.equal(result.error, undefined)
  const report = JSON.parse(readFileSync(output, 'utf8')), assertions = report.testResults.flatMap(test => test.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  assert.ok(assertions.length)
  const failed = assertions.filter(test => test.status === 'failed')
  if (mutation) {
    assert.equal(result.status, 1)
    assert.ok(failed.some(test => test.fullName.includes(selected) && test.failureMessages.some(message => /AssertionError|promise resolved .*instead of rejecting/u.test(message))), label + ': original behavior kills mutation')
  } else { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(failed.length, 0) }
  const loaded = readFileSync(sources, 'utf8').trim().split('\n').filter(Boolean).map(value => JSON.parse(value))
  for (const file of ['workbench-recovery-restore.ts', 'workbench-user-state.ts', 'storage-recovery-exports.ts'])
    assert.ok(loaded.some(source => source.absolutePath === join(root, 'apps/desktop/src/main', file)))
  if (mutation) assert.ok(loaded.some(source => source.mutation === mutation))
  phases.push({ label, passed: assertions.length - failed.length, failed: failed.length, exitCode: result.status })
  console.log(label + ': ' + (mutation ? 'target mutation killed' : 'passed'))
}
writeFileSync(join(evidence, 'verification.json'), JSON.stringify({ passed: true, root, phases,
  boundary: 'Original Main queues and exact member owners; real typed Unix bridge consumed by a second Node Host adapter process. Bootstrap and full startHost assembly have separate gates.' }, null, 2) + '\n', { mode: 0o600 })
