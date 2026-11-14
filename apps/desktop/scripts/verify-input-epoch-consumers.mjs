import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_INPUT_EPOCH_EVIDENCE
assert.ok(evidence, 'An exact private evidence directory is required')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const phases = []
for (const [label, selected, ui = false] of [
  ['baseline'],
  ['drop-new-manual-epoch', 'new manual composer'],
  ['drop-create-epoch', 'Main maps the frozen create'],
  ['drop-resume-epoch', 'Main preserves the original resume'],
  ['renew-old-queue-epoch', 'old queued key'],
  ['skip-new-create-reader', 'genuinely new user create'],
  ['drop-main-epoch-projection', 'authoritative Core Session epochs'],
  ['drop-renderer-epoch-projection', 'authoritative Core Session epochs'],
  ['renew-goal-epoch', 'original Goal references'],
  ['restored'],
  ['ui-baseline', undefined, true],
  ['skip-native-import-reader', 'keeps the exact native operation', true],
  ['skip-coordinator-reader', 'an original Reach C with an unknown ACK', true],
  ['ui-restored', undefined, true]
]) {
  const mutation = selected ? label : '', output = join(evidence, label + '.json')
  const sources = join(evidence, label + '.sources.ndjson'), dependencies = join(evidence, label + '.dependencies.ndjson')
  writeFileSync(sources, '', { mode: 0o600 }); writeFileSync(dependencies, '', { mode: 0o600 })
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/test/vitest.input-epoch-consumer.config.mts', '--reporter=json', '--outputFile=' + output, ...(selected ? ['-t', selected] : [])],
    { cwd: root, encoding: 'utf8', timeout: 90_000, env: { ...process.env, AGENTMUX_INPUT_EPOCH_MUTATION: mutation,
      AGENTMUX_INPUT_EPOCH_UI: ui ? '1' : '0', AGENTMUX_INPUT_EPOCH_SOURCE_PROOF: sources, AGENTMUX_BOOTSTRAP_SOURCE_PROOF: dependencies } })
  writeFileSync(join(evidence, label + '.log'), result.stdout + result.stderr, { mode: 0o600 })
  assert.equal(result.error, undefined)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  const assertions = report.testResults.flatMap(test => test.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  assert.ok(assertions.length, 'The actual consumer selection must be nonempty')
  const failed = assertions.filter(test => test.status === 'failed')
  if (mutation) {
    assert.equal(result.status, 1)
    assert.ok(failed.some(test => test.fullName.includes(selected) && test.failureMessages.some(message => /AssertionError|promise resolved .*instead of rejecting/u.test(message))), label + ': original behavior kills mutation')
  } else { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(failed.length, 0); assert.equal(assertions.length, ui ? 2 : 14) }
  const loaded = readFileSync(sources, 'utf8').trim().split('\n').filter(Boolean).map(value => JSON.parse(value))
  for (const file of ['apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/store.ts'])
    assert.ok(loaded.some(source => source.absolutePath === join(root, file)), file + ': original source was consumed')
  if (mutation) assert.ok(loaded.some(source => source.mutation === mutation && source.sha256 !== source.compiledSHA256), 'The compiled consumer actually changed')
  phases.push({ label, passed: assertions.length - failed.length, failed: failed.length, exitCode: result.status, ui })
  console.log(label + ': ' + (mutation ? 'target mutation killed' : 'passed'))
}
writeFileSync(join(evidence, 'verification.json'), JSON.stringify({ passed: true, root, phases,
  boundary: 'Actual Renderer Store/components, typed preload/Main IPC, RuntimeController source request maps and original Main data owner. Core intake and Native outer leaves controlled; no user Runtime, production writes, installed GUI or Core restoration claim. Legacy Main-only restoration is tested with unchanged missing Core epoch.' }, null, 2) + '\n', { mode: 0o600 })
