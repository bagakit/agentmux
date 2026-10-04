import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/state/terminal-workbench-scaling')
mkdirSync(evidence, { recursive: true })
function run(name, args, env = {}, failure = false) {
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024, timeout: 180000 })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(resolve(evidence, name + '.log'), output)
  if (failure) {
    assert.ok(!result.error && result.status !== 0, `${name}: must fail assertions, not execution`)
    assert.ok(output.includes(`MUTATION_APPLIED=${env.AGENTMUX_NAVIGATION_MUTANT}`), `${name}: actual production mutation must be consumed`)
    assert.match(output, /AssertionError/, `${name}: behavior must reject the mutation`)
  } else assert.equal(result.status, 0, `${name}: ${output.slice(-6000)}`)
  process.stdout.write(`${name}: ${failure ? 'killed' : 'passed'}\n`)
}
const config = 'apps/desktop/scripts/fixtures/terminal-workbench-scaling/vitest.config.mts'
const args = ['exec', 'vitest', 'run', '--config', config]
const selected = 'shares one graph|keeps mounted object|invalidates structural|does not rebuild window'
run('build', ['--filter', '@agentmux/client-ui...', 'build'])
run('types', ['--filter', '@agentmux/desktop', 'typecheck'])
run('targeted', [...args, 'apps/desktop/test/workbench-navigation-scaling.test.tsx',
  'apps/desktop/test/renderer-session-subscription-performance.test.tsx', '-t', selected])
run('terminal-browser-regression', [...args, 'apps/desktop/test/browser-state-related-updates.test.ts', 'apps/desktop/test/terminal-webgl-visibility.test.tsx'])
for (const mutant of ['window-cascade', 'object-cascade', 'pane-graph', 'structural-stale', 'unrelated-file-work']) {
  run(`mutation-${mutant}`, [...args, 'apps/desktop/test/workbench-navigation-scaling.test.tsx',
    'apps/desktop/test/renderer-session-subscription-performance.test.tsx', '-t', selected], { AGENTMUX_NAVIGATION_MUTANT: mutant }, true)
}
const callers = [
  ['apps/desktop/src/renderer/src/App.tsx', 'workbenchNavigationTabs(state.tabs)'],
  ['apps/desktop/src/renderer/src/hooks/useWorkbenchObjectLayout.ts', 'workbenchNavigationTabs(state.tabs)'],
  ['apps/desktop/src/renderer/src/lib/session-project-file-context.ts', 'workbenchNavigationCatalog(spatialState, topics)'],
  ['apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts', 'workbenchNavigationCatalog(state, topics)'],
  ['apps/desktop/src/renderer/src/components/SessionPane.tsx', 'createSessionProjectFileContextSelector(sessionId, mailboxOrigin)'],
  ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'useWorkbenchObjectLayout(workspaceId, residentLayout,']
].map(([path, anchor]) => {
  const content = readFileSync(resolve(root, path), 'utf8')
  const count = content.split(anchor).length - 1
  assert.ok(count > 0, `Nonempty external production caller required: ${path} → ${anchor}`)
  return { path, anchor, count }
})
assert.ok(callers.length > 0)
writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({ passed: true, mutations: ['window-cascade', 'object-cascade', 'pane-graph', 'structural-stale', 'unrelated-file-work'], callers }, null, 2) + '\n')
