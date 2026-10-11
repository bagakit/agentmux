import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const dock = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
const files = 'apps/desktop/src/renderer/src/components/MoteFilesTool.tsx'
const presentation = 'apps/desktop/src/renderer/src/lib/surface-tool-dock.ts'

await verifyRendererSourceMutations({
  name: 'space-content-scope-mutations',
  evidenceRoot: resolve(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT ?? resolve(import.meta.dirname, '../../../.bagakit/feature-tracker/space-context-clarity')),
  owningConfig: 'apps/desktop/test/git-workbench.config.mts',
  tests: ['apps/desktop/test/space-content-scope.test.tsx'],
  sources: [dock, files, presentation,
    'apps/desktop/src/renderer/src/components/WorkspaceFilesTool.tsx',
    'apps/desktop/src/renderer/src/components/WorkspaceFilesFrame.tsx',
    'apps/desktop/src/renderer/src/lib/mote-workface.ts',
    'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts',
    'apps/desktop/src/renderer/src/hooks/useScratchTopics.ts',
    'apps/desktop/src/shared/scratch-topics.ts',
    'apps/desktop/src/shared/scratch-topic-identity.mjs',
    'apps/desktop/scripts/verify-space-content-scope-mutations.mjs',
    'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/desktop/scripts/lib/fixture-values.mjs',
    'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx',
    'apps/desktop/test/helpers/file-tree-geometry.ts'],
  mutations: [
    { label: 'mote-label-consumes-confirmed-scope', file: dock,
      before: 'const contentSlot = contentSlotPresentation(isScratch, moteScope)',
      after: 'const contentSlot = contentSlotPresentation(isScratch, null)' },
    { label: 'mote-tools-follow-content-not-display', file: presentation,
      before: 'input.isScratch || input.moteScope ? WORKSPACE_TOOL_IDS.filter',
      after: 'input.isScratch ? WORKSPACE_TOOL_IDS.filter' },
    { label: 'mote-files-read-original-resource', file: files,
      before: 'workspace={scope.workspace} visible={visible}',
      after: 'workspace={useAppStore.getState().config!.workspaces.find(workspace => workspace.id === useAppStore.getState().activeWorkspaceId)!} visible={visible}' },
    { label: 'mote-path-is-physical-object-directory', file: files,
      before: 'contextPath={scratchTopicPhysicalPath(scope.workspace, scope.topic)}',
      after: 'contextPath={scope.workspace.path}' },
    { label: 'mote-metadata-issue-remains-observable', file: files,
      before: '{scope.issue ? <div className="surface-inline-error"',
      after: '{false ? <div className="surface-inline-error"' }
  ]
})
