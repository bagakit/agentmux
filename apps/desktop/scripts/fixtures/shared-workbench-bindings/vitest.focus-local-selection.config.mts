import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutations = {
  'session-only-local-selection': ['apps/desktop/src/renderer/src/App.tsx',
    'useAppStore.getState().selectExecutionFocusReference(reference, agentFocus.execution)',
    "const state = useAppStore.getState(), surface = state.tabs[reference.tabId]?.regions[reference.regionId]; if (surface && isSessionSurface(surface)) state.selectExecutionFocusReference(reference, agentFocus.execution)"],
  'agent-only-held-occurrence': ['apps/desktop/src/renderer/src/lib/focus-tab-projection.ts',
    'const confirmed = reference && tabs[reference.tabId]?.regions[reference.regionId] &&\n    catalog.locations.some(location => sameWorkbenchProjectionSelection(location, reference))',
    'const confirmed = reference && choices.some(choice => sameWorkbenchProjectionSelection(choice, reference))'],
  'drop-confirmed-display-group': ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
    'const ownerId = originalOwnerId ?? confirmedDisplayGroup',
    'const ownerId = originalOwnerId'],
  'false-display-recovery-notice': ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
    '{originalOwnerId && (!storedLayout || !ownerByTab.has(tab.id)) ?',
    '{ownerId && (!storedLayout || !ownerByTab.has(tab.id)) ?'],
  'ignore-local-intent': ['apps/desktop/src/renderer/src/store.ts',
    "if (state.mainSurface !== 'agents' || !expected.sessionId || execution.sessionId !== expected.sessionId ||\n      (expected.reference\n        ? !sameWorkbenchProjectionSelection(execution.reference ?? null, expected.reference)\n        : execution.reference !== undefined)) return",
    'if (!expected.sessionId) return']
} as const
export default defineConfig({ ...original, root,
  plugins: [...original.plugins ?? [], { name: 'loaded-focus-local-selection', enforce: 'pre',
    transform(source, id) {
      const path = id.split('?')[0]!
      if (!path.startsWith(root + '/apps/desktop/src/')) return
      const mutation = process.env.AGENTMUX_FOCUS_LOCAL_MUTATION as keyof typeof mutations | undefined
      let code = source
      if (mutation) {
        const change = mutations[mutation]; assert.ok(change, 'Known local selection mutation')
        if (path === resolve(root, change[0])) {
          assert.equal(source.split(change[1]).length - 1, 1, 'One consumed local-selection mutation anchor')
          code = source.replace(change[1], change[2])
        }
      }
      if (process.env.AGENTMUX_FOCUS_LOCAL_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_LOCAL_LOADED,
        JSON.stringify({ path: relative(root, path), sourceSHA256: createHash('sha256').update(source).digest('hex'),
          loadedSHA256: createHash('sha256').update(code).digest('hex'), mutated: code !== source,
          ...(code !== source ? { mutation } : {}) }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/focus-local-workbench-selection.test.tsx'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15000 }
})
