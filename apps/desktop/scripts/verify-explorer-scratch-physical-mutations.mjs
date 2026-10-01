import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const file = 'apps/desktop/src/renderer/src/components/FileExplorer.tsx'
await verifyRendererSourceMutations({
  name: 'explorer-scratch-physical-mutations',
  tests: ['apps/desktop/test/file-explorer-scratch-physical-path.test.tsx'],
  sources: [file, 'apps/desktop/src/shared/scratch-topics.ts', 'apps/desktop/src/renderer/src/lib/scratch-topic-snapshots.ts',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx', 'packages/client-ui/package.json'],
  mutations: [
    { label: 'physical-title-canonical-consumer', file,
      before: 'const physical = scratchWorkspaceFilePath(workspace, scratchTopics, node.path)',
      after: 'const physical = `${workspace.path}/${node.path}`' },
    { label: 'unconfirmed-copy-admission', file,
      before: 'const absolute = scratchWorkspaceFilePath(workspace,\n      scratchTopicsForWorkspace(useAppStore.getState().scratchTopicSnapshots, workspace), path)',
      after: 'const absolute = scratchWorkspaceFilePath(workspace,\n      scratchTopicsForWorkspace(useAppStore.getState().scratchTopicSnapshots, workspace), path) ?? `${workspace.path}/${path}`' }
  ]
})
