import assert from 'node:assert/strict'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

process.env.AGENTMUX_WORKFACE_MUTATION_CONFIG = 'vitest.mutation.config.mts'
const task = process.argv[process.argv.indexOf('--task') + 1]
assert.equal(task, 'T-001', 'A task must have its own implemented verification; unsupported tasks cannot pass.')
await verifyRendererSourceMutations({
  name: 'file-formats-T-001',
  owningConfig: 'apps/desktop/test/file-format-capabilities.config.mts',
  tests: ['apps/desktop/test/workspace-file-format.test.ts', 'apps/desktop/test/workface-file-view-control.test.tsx'],
  sources: ['apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/workface-monaco-fixture.ts',
    'apps/desktop/test/helpers/workface-control-fixture.ts', 'apps/desktop/test/helpers/workface-file-fixture.ts',
    'apps/desktop/test/helpers/spatial-control-owner-fixture.ts', 'apps/desktop/test/helpers/startup-observation-api-fixture.ts',
    'apps/desktop/src/shared/workspace-file-format.ts', 'apps/desktop/src/renderer/src/lib/workface-file-view.ts',
    'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx', 'apps/desktop/src/renderer/src/components/file-preview/SourceFilePreview.tsx'],
  mutations: [
    { label: 'html-preview-disconnected', file: 'apps/desktop/src/shared/workspace-file-format.ts', before: "extensions: ['html', 'htm']", after: "extensions: ['not-html']" },
    { label: 'renderer-claim-available', file: 'apps/desktop/src/renderer/src/lib/workface-file-view.ts', before: "format.previewConfirmation === 'renderer'", after: 'false' }
  ]
})
