import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), evidence = process.env.AGENTMUX_CREATION_OBSERVATION_EVIDENCE
assert.ok(evidence, 'An exact private evidence directory is required')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const phases = []
for (const [label, selected] of [['baseline'], ['native-observation-as-session', 'Native import retry'],
  ['reopen-observation-as-session', 'reopen fallback'], ['spatial-observation-as-session', 'original spatial inspection'],
  ['fork-observation-as-session', 'fork retains'], ['name-observation-as-session', 'Takeover naming'], ['restored']]) {
  const mutation = selected ? label : '', output = join(evidence, label + '.json'), sources = join(evidence, label + '.sources.ndjson')
  writeFileSync(sources, '', { mode: 0o600 })
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/test/vitest.creation-observation-consumer.config.mts', '--reporter=json', '--outputFile=' + output, ...(selected ? ['-t', selected] : [])],
    { cwd: root, encoding: 'utf8', timeout: 90_000, env: { ...process.env, AGENTMUX_CREATION_OBSERVATION_MUTATION: mutation, AGENTMUX_CREATION_OBSERVATION_SOURCE_PROOF: sources } })
  writeFileSync(join(evidence, label + '.log'), result.stdout + result.stderr, { mode: 0o600 })
  assert.equal(result.error, undefined)
  const report = JSON.parse(readFileSync(output, 'utf8')), assertions = report.testResults.flatMap(test => test.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  const failed = assertions.filter(test => test.status === 'failed')
  assert.equal(assertions.length, mutation ? 2 : 10)
  if (mutation) {
    assert.equal(result.status, 1)
    assert.ok(failed.some(test => test.fullName.includes(selected) && test.failureMessages.some(message => /AssertionError|promise resolved .*instead of rejecting/u.test(message))), label + ': original behavior kills mutation')
  } else { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(failed.length, 0) }
  const loaded = readFileSync(sources, 'utf8').trim().split('\n').filter(Boolean).map(value => JSON.parse(value))
  for (const file of ['store.ts', 'lib/space-agent-control.ts', 'lib/session-takeover.ts'])
    assert.ok(loaded.some(source => source.absolutePath === join(root, 'apps/desktop/src/renderer/src', file)))
  if (mutation) assert.ok(loaded.some(source => source.mutation === mutation && source.sha256 !== source.compiledSHA256))
  phases.push({ label, passed: assertions.length - failed.length, failed: failed.length, exitCode: result.status })
  console.log(label + ': ' + (mutation ? 'target mutation killed' : 'passed'))
}
writeFileSync(join(evidence, 'verification.json'), JSON.stringify({ passed: true, root, phases,
  boundary: 'Original Store native retry/reopen and spatial inspect/fork/Takeover naming consumers. Core contract DTO external observation leaf controlled. Neither a retained Native Run nor prepared/closed creation is promoted to semantic Session; no Runtime, production or Native lifecycle effects.' }, null, 2) + '\n', { mode: 0o600 })
