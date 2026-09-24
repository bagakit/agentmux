import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..')
const privateRunner = await mkdtemp('/tmp/amx-app-workspace-runner-')
const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const owning = 'apps/desktop/scripts/fixtures/browser-app-workspace-cost/vitest.owning.config.mts'
try {
  // The mature copy runner owns private Source mutation and restore/hash checks. Its
  // config is replaced only in this private runner to keep the actual returned-tree
  // Profiler observation. The real WT owning gate already checked Core dist freshness;
  // copy timestamps cannot repeat that check against freshly copied source/dist.
  let runner = await readFile(join(root, 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs'), 'utf8')
  const rootAnchor = "const root = resolve(import.meta.dirname, '../../../..')"
  assert.equal(runner.split(rootAnchor).length - 1, 1)
  runner = runner.replace(rootAnchor, 'const root = ' + JSON.stringify(root))
  const envAnchor = "pnpm_config_verify_deps_before_run: 'false'"
  assert.equal(runner.split(envAnchor).length - 1, 1)
  runner = runner.replace(envAnchor, envAnchor + ', AGENTMUX_SOURCE_CANDIDATE_COMMIT: ' + JSON.stringify(candidateCommit) +
    ", AGENTMUX_APP_SOURCE_CONSUMER_REPORT: join(evidence, label + '-raw.json'), AGENTMUX_APP_LOADED_SOURCE: join(evidence, label + '-loaded.jsonl')")
  const configLine = runner.split('\n').filter(line => line.includes("await writeFile(join(copy, 'vitest.mutation.config.mts')"))
  assert.equal(configLine.length, 1)
  const config = `import { defineConfig } from 'vitest/config';\nimport owning from './${owning}';\nexport default defineConfig({ ...owning, test: { ...owning.test, globalSetup: [] } });\n`
  runner = runner.replace(configLine[0], "    await writeFile(join(copy, 'vitest.mutation.config.mts'), " + JSON.stringify(config) + ')')
  await writeFile(join(privateRunner, 'runner.mjs'), runner)
  const { verifyRendererSourceMutations } = await import(pathToFileURL(join(privateRunner, 'runner.mjs')))
  const app = 'apps/desktop/src/renderer/src/App.tsx'
  const memory = 'apps/desktop/src/renderer/src/lib/surface-memory-budget-coordinator.tsx'
  const guard = `  if (!shallow(previousState.current.monacoRegionIds, state.monacoRegionIds) ||
      !shallow(previousState.current.browserRegionIds, state.browserRegionIds)) previousState.current = state`
  await verifyRendererSourceMutations({
    name: 'browser-actual-app-workspace-source-mutations',
    tests: ['apps/desktop/scripts/fixtures/browser-app-workspace-cost/app-workspace-cost.fixture.tsx'],
    sources: [app, memory, owning, 'vitest.config.ts', 'vitest.dist-freshness.ts',
      'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/browser-state.ts',
      'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
      'apps/desktop/src/renderer/src/components/SessionPane.tsx',
      'apps/desktop/src/renderer/src/lib/surface-memory-budget-candidates.ts',
      'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
      'apps/desktop/scripts/verify-browser-app-workspace-costs-mutations.mjs'],
    mutations: [
      { label: 'whole-app-memo-deleted', file: app,
        before: 'const WorkspaceWorkbench = memo(WorkspaceWorkbenchView)',
        after: 'const WorkspaceWorkbench = WorkspaceWorkbenchView' },
      { label: 'whole-settings-navigation-stability-removed', file: app,
        before: `  const openSettings = useCallback((section: SettingsPageId, executorId?: string): void => setSettingsRoute({ section, executorId }), [])
  const settingsNavigation = useMemo(() => ({ open: openSettings }), [openSettings])`,
        after: `  const openSettings = (section: SettingsPageId, executorId?: string): void => setSettingsRoute({ section, executorId })
  const settingsNavigation = { open: openSettings }` },
      { label: 'whole-memory-membership-guard-bypassed', file: memory,
        before: guard, after: '  previousState.current = state' },
      { label: 'whole-memory-membership-guard-freezes-changes', file: memory,
        before: guard, after: '  void state' }
    ]
  })
} finally { await rm(privateRunner, { recursive: true, force: true }) }
