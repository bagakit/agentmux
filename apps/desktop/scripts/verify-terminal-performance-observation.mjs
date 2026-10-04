import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/state/terminal-performance-verification')
mkdirSync(evidence, { recursive: true })
function run(name, args, env = {}, expectedFailure = false) {
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024, timeout: 180_000 })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(resolve(evidence, name + '.log'), output)
  if (expectedFailure) {
    assert.ok(!result.error && result.status !== 0, `${name}: mutation must fail tests, not timeout or fail to execute`)
    assert.ok(output.includes(`MUTATION_APPLIED=${env.AGENTMUX_TERMINAL_COST_MUTANT}`), `${name}: production mutation must be consumed`)
    assert.match(output, /AssertionError|expected .* to|expected .*to be|Tests\s+\d+ failed/s, `${name}: behavior assertion must reject mutant`)
  } else assert.equal(result.status, 0, `${name} failed: ${output.slice(-6000)}`)
  process.stdout.write(`${name}: ${expectedFailure ? 'killed' : 'passed'}\n`)
}
const edges = [
  ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', /useObservedAppStore\('composer'/g],
  ['apps/desktop/src/renderer/src/components/SessionPane.tsx', /useObservedAppStore\('sessionPane'/g],
  ['apps/desktop/src/renderer/src/store.ts', /rendererPerformance\.(sessionEvent|snapshot)\(/g],
  ['apps/desktop/src/renderer/src/components/TerminalView.tsx', /rendererPerformance\.(terminalWrite|registerTerminal)\(/g],
  ['apps/desktop/src/renderer/src/components/RendererResourceOwners.tsx', /rendererPerformance\.observeMainThread\(/g],
  ['apps/desktop/src/main/resource-usage-control.ts', /performance: result\.performance/g],
  ['packages/core/src/metrics.ts', /performance: performanceParser/g],
  ['apps/desktop/resources/toolkit/performance.mjs', /payload: parseMetricsObservation\(/g]
].map(([path, pattern]) => {
  const text = readFileSync(resolve(root, path), 'utf8'), matches = [...text.matchAll(pattern)]
  assert.ok(text.length && matches.length, `Nonempty external production caller required: ${path}`)
  return { path, matches: matches.length }
})
assert.equal(edges.find(edge => edge.path === 'packages/core/src/metrics.ts').matches, 2, 'Both strict metrics codecs must consume the cost parser')
writeFileSync(resolve(evidence, 'callers.json'), JSON.stringify(edges, null, 2) + '\n')
run('build', ['--filter', '@agentmux/client-ui...', 'build'])
run('types', ['--filter', '@agentmux/desktop', 'typecheck'])
run('cost-comparison', ['exec', 'vitest', 'run', 'apps/desktop/test/renderer-performance-cost.test.tsx'], { AGENTMUX_TERMINAL_COST_BENCHMARK: resolve(evidence, 'cost-comparison.json') })
const config = 'apps/desktop/scripts/fixtures/terminal-performance/vitest.config.mts'
run('baseline', ['exec', 'vitest', 'run', '--config', config])
run('outer-strict-codec', ['exec', 'vitest', 'run', 'packages/core/test/metrics-control-host.test.ts', '-t', 'keeps unsupported typed'])
for (const mutant of ['retention', 'cleanup', 'projection', 'visibility']) {
  const target = mutant === 'projection' ? 'apps/desktop/test/metrics-main-control.test.ts'
    : mutant === 'cleanup' ? 'apps/desktop/test/terminal-webgl-visibility.test.tsx' : 'apps/desktop/test/renderer-performance.test.tsx'
  run(`mutation-${mutant}`, ['exec', 'vitest', 'run', '--config', config, target], { AGENTMUX_TERMINAL_COST_MUTANT: mutant }, true)
}
writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({ passed: true, callers: edges, mutations: ['retention','cleanup','projection','visibility'] }, null, 2) + '\n')
