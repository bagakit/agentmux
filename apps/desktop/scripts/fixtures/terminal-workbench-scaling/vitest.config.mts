import assert from 'node:assert/strict'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutants: Record<string, [string, string, string]> = {
  'window-cascade': ['apps/desktop/src/renderer/src/App.tsx', 'workbenchNavigationTabs(state.tabs)', 'state.tabs'],
  'object-cascade': ['apps/desktop/src/renderer/src/hooks/useWorkbenchObjectLayout.ts', 'workbenchNavigationTabs(state.tabs)', 'state.tabs'],
  'pane-graph': ['apps/desktop/src/renderer/src/lib/session-project-file-context.ts', 'const catalog = workbenchNavigationCatalog(spatialState, topics)', 'const catalog = workbenchNavigationCatalog({ ...spatialState, layouts: { ...spatialState.layouts } }, topics)'],
  'unrelated-file-work': ['apps/desktop/src/renderer/src/lib/session-project-file-context.ts', 'if (previous && relatedInputs && inputs.every', 'if (false && previous && relatedInputs && inputs.every'],
  'structural-stale': ['apps/desktop/src/renderer/src/lib/workbench-navigation-catalog.ts', "a.workspaceId === b.workspaceId && a.browserId === b.browserId", "a.workspaceId === b.workspaceId /* mutant: ignore Browser identity */"]
}
export default defineConfig({ ...base, root, plugins: [{ name: 'actual-navigation-mutations', enforce: 'pre', transform(code, id) {
  const mutant = process.env.AGENTMUX_NAVIGATION_MUTANT, edit = mutants[mutant ?? '']
  if (edit && relative(root, id.split('?')[0]!) === edit[0]) {
    assert.equal(code.split(edit[1]).length - 1, 1, 'Must mutate exactly one production anchor')
    process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    return { code: code.replace(edit[1], edit[2]), map: null }
  }
} }], test: { ...base.test, include: ['apps/desktop/test/workbench-navigation-scaling.test.tsx',
  'apps/desktop/test/renderer-session-subscription-performance.test.tsx', 'apps/desktop/test/session-pane-project-file-links.test.tsx',
  'apps/desktop/test/browser-state-related-updates.test.ts', 'apps/desktop/test/terminal-webgl-visibility.test.tsx'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 12000 } })
