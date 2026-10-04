import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const store = 'apps/desktop/src/renderer/src/store.ts'
const pane = 'apps/desktop/src/renderer/src/components/GitWorkbenchPane.tsx'
const persistence = 'apps/desktop/src/renderer/src/lib/workbench-persistence.ts'
await verifyRendererSourceMutations({
  name: 'git-commit-mutations', owningConfig: 'apps/desktop/test/git-workbench.config.mts',
  tests: ['apps/desktop/test/git-commit-store.test.ts', 'apps/desktop/test/git-commit-workbench.test.tsx'],
  sources: [store, pane, persistence, 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'original-history-scope', file: pane,
      before: "const foreignHistory = history.result?.kind === 'ready' &&",
      after: "const foreignHistory = false && history.result?.kind === 'ready' &&" },
    { label: 'git-open-navigation', file: store,
      before: "get().focusRegion(workspaceId, tabId, regionId, 'navigation', groupId)\n    return { tabId, regionId }",
      after: 'return { tabId, regionId }' },
    { label: 'fixed-diff-navigation', file: store,
      before: "get().focusRegion(workspaceId, tabId, tab.layout.activeRegionId, 'navigation', groupId)",
      after: 'void groupId' },
    { label: 'commit-blob-owner', file: store,
      before: "? bridge.commitDiff(surface.workspaceId, surface.comparison)",
      after: "? bridge.branchDiff(surface.workspaceId, surface.comparison as any)" },
    { label: 'late-commit-response', file: pane,
      before: 'if (current) setRead(value)', after: 'setRead(value)' },
    { label: 'rename-original-path', file: pane,
      before: 'file: { path: file.path, origPath: file.origPath }', after: 'file: { path: file.path, origPath: null }' },
    { label: 'explicit-merge-parent', file: pane,
      before: 'parentOid: event.currentTarget.value', after: 'parentOid: result.commit.parents[0]!' },
    { label: 'retained-git-region', file: persistence,
      before: "case 'git':\n    case 'git-diff':\n      return true", after: "case 'git': return false\n    case 'git-diff':\n      return true" }
  ]
})
