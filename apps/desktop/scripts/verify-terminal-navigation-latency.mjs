import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(root, '.local/state/terminal-navigation-latency')
mkdirSync(evidence, { recursive: true })
function run(name, args, mutant) {
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...(mutant ? { AGENTMUX_TAB_SWITCH_MUTANT: mutant } : {}) }, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(resolve(evidence, name + '.log'), output)
  if (mutant) {
    assert.ok(!result.error && result.status !== 0, `${name}: mutation must fail assertions`)
    assert.ok(output.includes(`MUTATION_APPLIED=${mutant}`), `${name}: mutation not consumed`)
    assert.match(output, /AssertionError/, `${name}: execution failure is not proof`)
  } else assert.equal(result.status, 0, `${name}: ${output.slice(-6000)}`)
  process.stdout.write(`${name}: ${mutant ? 'killed' : 'passed'}\n`)
}
run('build', ['--filter', '@agentmux/client-ui...', 'build'])
run('types', ['--filter', '@agentmux/desktop', 'typecheck'])
const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/terminal-navigation-latency/vitest.config.mts']
run('production-regression', [...args, 'apps/desktop/test/tab-switch-', 'apps/desktop/test/terminal-webgl-visibility.test.tsx',
  'apps/desktop/test/renderer-performance.test.tsx', 'packages/core/test/renderer-tab-switch-codec.test.ts'])
run('public-get-watch', [...args, 'packages/core/test/metrics-control-host.test.ts', '-t', 'keeps unsupported typed|coalesces synchronous snapshots'])
const mutants = ['button-disconnected', 'placement-disconnected', 'terminal-disconnected', 'coarse-occurrence', 'unbounded-records', 'departed-callback']
for (const mutant of mutants) run('mutation-' + mutant, [...args, 'apps/desktop/test/tab-switch-observation.test.ts', 'apps/desktop/test/tab-switch-mounted.test.tsx', 'apps/desktop/test/terminal-webgl-visibility.test.tsx'], mutant)
const callers = [
  ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'tabSwitchObservation.begin(switchTarget, mode, event.nativeEvent.timeStamp)'],
  ['apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx', 'tabSwitchObservation.registerPlacement(switchTarget'],
  ['apps/desktop/src/renderer/src/components/TerminalView.tsx', 'tabSwitchObservation.registerTerminal(switchTarget'],
  ['apps/desktop/src/renderer/src/lib/renderer-performance.ts', 'tabSwitches: tabSwitchObservation.snapshot()'],
  ['packages/core/src/metrics.ts', 'tabSwitches: boundedArray(16,'],
  ['packages/core/src/agentmux.ts', 'const result = await client.call(method, invocation.params'],
  ['packages/core/src/public-rpc-service.ts', "request.operation === 'metrics.get'"],
  ['packages/core/src/public-rpc-client.ts', 'parseMetricsObservation(p.observation)']
].map(([path, anchor]) => {
  const count = readFileSync(resolve(root, path), 'utf8').split(anchor).length - 1
  assert.ok(count > 0, `Required real external caller: ${path} ${anchor}`)
  return { path, anchor, count }
})
assert.ok(callers.length > 0)
writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({ passed: true, mutants, callers }, null, 2) + '\n')
