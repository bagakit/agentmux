import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const store = 'apps/desktop/src/renderer/src/store.ts'
const pane = 'apps/desktop/src/renderer/src/features/git/GitWorkbenchPane.tsx'
const sidebar = 'apps/desktop/src/renderer/src/components/ProjectFilesTool.tsx'
const details = 'apps/desktop/src/renderer/src/features/git/commit/useGitCommitDetails.ts'
const candidates = 'apps/desktop/src/renderer/src/lib/surface-memory-budget-candidates.ts'
const codec = 'packages/core/src/public-rpc-git.ts'
await verifyRendererSourceMutations({
  name: 'git-commit-mutations', owningConfig: 'apps/desktop/test/git-workbench.config.mts',
  ...(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT ? { evidenceRoot: process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT } : {}),
  tests: ['apps/desktop/test/git-commit-store.test.ts', 'apps/desktop/test/git-commit-workbench.test.tsx', 'packages/core/test/public-git.test.ts'],
  sources: [store, pane, sidebar, details, codec, candidates, 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/git-history-viewport.ts'],
  mutations: [
    { label: 'original-history-scope', file: pane,
      before: 'const foreign = Boolean(ready && (', after: 'const foreign = Boolean(false && ready && (' },
    { label: 'fixed-sidebar-destination', file: sidebar,
      before: 'onSelectCommit={snapshot => openCommit(workspace.id, snapshot)}',
      after: 'onSelectCommit={snapshot => openHistory(workspace.id, snapshot)}' },
    { label: 'preserved-range-choice', file: pane,
      before: 'const reference = shared?.history.reference', after: 'const reference = undefined' },
    { label: 'completed-window-handoff', file: pane,
      before: 'if (changingOwner.window) history.adoptWindow(changingOwner.window)', after: 'void changingOwner.window' },
    { label: 'late-commit-response', file: details,
      before: 'if (current) setRead(value)', after: 'setRead(value)' },
    { label: 'replaced-inline-diff-release', file: store,
      before: 'if (existing && !sameSelection) state.releaseBranchDiff(regionId)', after: 'void sameSelection' },
    { label: 'inline-monaco-budget-owner', file: candidates,
      before: 'if (!surface.selection || !surface.file) return null', after: 'return null' },
    { label: 'parent-requires-fixed-commit', file: codec,
      before: "if (p.oid === undefined) invalid('A comparison parent requires an exact commit OID.', code)",
      after: 'void p.oid' }
  ]
})
