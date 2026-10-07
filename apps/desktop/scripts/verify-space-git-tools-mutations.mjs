import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const context = 'apps/desktop/src/renderer/src/lib/workspace-zone-context.ts'
const dock = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
const changes = 'apps/desktop/src/renderer/src/components/ChangesPanel.tsx'

await verifyRendererSourceMutations({
  name: 'space-zone-git-tools-mutations',
  owningConfig: 'apps/desktop/test/git-workbench.config.mts',
  ...(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT ? { evidenceRoot: process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT } : {}),
  tests: ['apps/desktop/test/workspace-zones.test.tsx', 'apps/desktop/test/space-git-tools.test.tsx'],
  sources: [context, dock, changes, 'apps/desktop/src/renderer/src/components/WorkspaceZonesPanel.tsx',
    'apps/desktop/src/renderer/src/lib/workspace-zone-file-actions.ts',
    'apps/desktop/src/renderer/src/components/WorkspaceGitTool.tsx', 'apps/desktop/src/renderer/src/components/ProjectFilesTool.tsx',
    'apps/desktop/src/renderer/src/lib/workspace-git-view.ts', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/lib/surface-tool-dock.ts', 'apps/desktop/src/renderer/src/App.tsx',
    'apps/desktop/src/renderer/src/hooks/useGitStatus.ts', 'apps/desktop/src/renderer/src/hooks/useWorkspaceBranches.ts',
    'apps/desktop/src/renderer/src/hooks/useGitAheadBehind.ts', 'apps/desktop/src/renderer/src/components/BranchesPanel.tsx',
    'apps/desktop/src/renderer/src/lib/workface-file-open.ts',
    'apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'apps/desktop/src/renderer/src/lib/file-workbench-state.ts',
    'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx',
    'apps/desktop/test/helpers/file-tree-geometry.ts',
    'apps/desktop/test/helpers/workface-monaco-fixture.ts',
    'apps/desktop/scripts/lib/fixture-values.mjs'],
  mutations: [
    { label: 'zone-bindings-are-not-global-resources', file: context,
      before: 'const zones = catalog.zones.filter(zone => bound.has(zone.zoneId))',
      after: 'const zones = catalog.zones' },
    { label: 'unknown-zone-cannot-target-project-writes', file: context,
      before: 'resource = null\n      files = null', after: 'resource = workspace\n      files = null' },
    { label: 'git-is-a-peer-not-files-content', file: dock,
      before: 'hidden={selectedTool !== \'git\' || isScratch}', after: 'hidden={selectedTool !== \'files-branches\' || isScratch}' },
    { label: 'drafts-belong-to-exact-worktree', file: changes,
      before: 'const draftKey = gitWorkspaceKey(workspace)', after: 'const draftKey = "all-worktrees"' },
    { label: 'changes-diff-keeps-zone-resource-and-placement', file: changes,
      before: "await openWorkspaceZoneFile(display, path, 'diff')", after: 'await openFileDiff(path)' },
    { label: 'public-file-focus-does-not-grant-caret-transfer', file: 'apps/desktop/src/renderer/src/lib/workface-file-open.ts',
      before: "inputPolicy: NonNullable<SpatialControlOptions['fileInputPolicy']> = 'preserve'",
      after: "inputPolicy: NonNullable<SpatialControlOptions['fileInputPolicy']> = 'target'" }
  ]
})
