import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_SOURCE_RESTORE_EVIDENCE
assert.ok(evidence, 'An exact private evidence directory is required')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const phases = []
for (const [label, selected] of [
  ['baseline'], ['source-user-guard', 'refuses http-user'], ['source-frozen-target', 'preparation that changes'],
  ['source-prepare-dispatch', 'dispatches storage.source.prepare'], ['restored']
]) {
  const mutation = selected ? label : '', output = join(evidence, label + '.json'), sources = join(evidence, label + '.sources.ndjson')
  writeFileSync(sources, '', { mode: 0o600 })
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'packages/core/test/vitest.storage-recovery-rpc.config.mts', '--reporter=json', '--outputFile=' + output, ...(selected ? ['-t', selected] : [])],
    { cwd: root, encoding: 'utf8', timeout: 90_000, env: { ...process.env, AGENTMUX_SOURCE_RESTORE_MUTATION: mutation, AGENTMUX_RECEIPT_SOURCE_LOADS: sources } })
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
  for (const file of ['public-rpc-service.ts', 'storage-recovery-rpc.ts', 'agentmux-cli-commands.ts'])
    assert.ok(loaded.some(source => source.path === join(root, 'packages/core/src', file)))
  if (mutation) assert.ok(loaded.some(source => source.mutation === mutation))
  phases.push({ label, passed: assertions.length - failed.length, failed: failed.length, exitCode: result.status })
  console.log(label + ': ' + (mutation ? 'target mutation killed' : 'passed'))
}
writeFileSync(join(evidence, 'verification.json'), JSON.stringify({ passed: true, root, phases,
  boundary: 'Actual source service/codec/CLI plus real Unix CLI request/receipt; original data effects remain the Main owner integration gate.' }, null, 2) + '\n', { mode: 0o600 })
