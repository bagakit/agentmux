import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
export function assertSourceConsumerProof(loaded, { root, owner, selection, label }) {
  if (root !== owner) assert.ok(!loaded.some(source => source.path.startsWith(join(root, 'packages/core') + '/')), 'No stale relative Core dependency')
  if (!selection || selection === 'goal' || selection === 'ordinary') assert.ok(loaded.some(source => source.path === join(owner, 'apps/host/src/spatial-agent-control.ts')), 'Actual current Host original owner was consumed')
  if (selection === 'input') {
    const consumers = {
      'drop-main-runtime-pin': ['apps/desktop/src/main/runtime-controller.ts'],
      'drop-public-resume-cut': ['apps/desktop/src/preload/index.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/runtime-controller.ts'],
      'renew-public-control-cut': ['apps/desktop/src/renderer/src/store.ts']
    }
    assert.ok(Object.hasOwn(consumers, label), 'A narrow mutation must name its actual consuming boundary')
    for (const path of consumers[label]) assert.ok(loaded.some(source => source.path === join(root, path)), 'Actual narrow input consumer was not loaded: ' + path)
  } else assert.ok(loaded.some(source => source.path === join(owner, 'packages/core/src/agent-open-contract.ts')), 'Actual Core open contract was consumed')
}
export function verifyNewSourceInputs() {
const root = resolve(process.env.AGENTMUX_SOURCE_INPUT_ROOT ?? resolve(import.meta.dirname, '../../..')), evidence = process.env.AGENTMUX_SOURCE_INPUT_EVIDENCE
assert.ok(evidence, 'An exact private evidence directory is required')
const owner = process.env.AGENTMUX_SOURCE_INPUT_OWNER_ROOT ?? dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim())
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const phases = []
for (const [label, selected, selection] of [['baseline'],
  ['drop-goal-source-cut', 'the Goal picker uses original Source', 'goal'],
  ['drop-ordinary-source-cut', 'ordinary Source Start crosses', 'ordinary'],
  ['drop-main-source-selector', 'original Main IPC', 'helper'],
  ['block-pinned-source-on-reader-failure', 'unavailable namespace reader', 'helper'],
  ['invent-cut-on-reader-failure', 'unavailable namespace reader', 'helper'],
  ['accept-wrong-runtime', 'wrong Runtime reply', 'helper'],
  ['block-optional-source-description', 'optional Source description', 'helper'],
  ['drop-main-runtime-pin', 'Main maps the frozen create', 'input'],
  ['drop-public-resume-cut', 'Main preserves the original public resume', 'input'],
  ['renew-public-control-cut', 'actual public resume control', 'input'], ['restored']]) {
  const mutation = selected ? label : '', output = join(evidence, label + '.json'), sources = join(evidence, label + '.sources.ndjson')
  writeFileSync(sources, '', { mode: 0o600 })
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/test/vitest.new-source-agent-input.config.mts', '--reporter=json', '--outputFile=' + output, ...(selected ? ['-t', selected] : [])],
    { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, AGENTMUX_SOURCE_INPUT_MUTATION: mutation,
      AGENTMUX_SOURCE_INPUT_SELECTION: selection ?? '', AGENTMUX_SOURCE_INPUT_SOURCE_PROOF: sources } })
  writeFileSync(join(evidence, label + '.log'), result.stdout + result.stderr, { mode: 0o600 })
  assert.equal(result.error, undefined)
  const report = JSON.parse(readFileSync(output, 'utf8')), assertions = report.testResults.flatMap(test => test.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  const failed = assertions.filter(test => test.status === 'failed')
  assert.ok(assertions.length)
  if (mutation) {
    assert.equal(result.status, 1)
    assert.ok(failed.some(test => test.fullName.includes(selected) && test.failureMessages.some(message => /AssertionError|promise resolved .*instead of rejecting|promise rejected .*instead of resolving/u.test(message))), label + ': original behavior kills mutation')
  } else { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(failed.length, 0); assert.equal(assertions.length, 17) }
  const loaded = readFileSync(sources, 'utf8').trim().split('\n').filter(Boolean).map(value => JSON.parse(value))
  assertSourceConsumerProof(loaded, { root, owner, selection, label })
  if (mutation) assert.ok(loaded.some(source => source.mutation === mutation && source.sha256 !== source.compiledSHA256))
  phases.push({ label, passed: assertions.length - failed.length, failed: failed.length, exitCode: result.status })
  console.log(label + ': ' + (mutation ? 'target mutation killed' : 'passed'))
}
writeFileSync(join(evidence, 'verification.json'), JSON.stringify({ passed: true, root, owner, phases,
  boundary: 'Original Goal/NewTab components through trusted Main/preload, real Unix or signed Source RPC and actual current Host spatial admission. Provider/Native final creation leaves are controlled, with Source0 observer denial still available and E1 original owner refusal before create. No production/user Runtime effects or physical Native Start claim.' }, null, 2) + '\n', { mode: 0o600 })

}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) verifyNewSourceInputs()
