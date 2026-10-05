import assert from 'node:assert/strict'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

process.env.AGENTMUX_WORKFACE_MUTATION_CONFIG = 'vitest.mutation.config.mts'
const task = process.argv[process.argv.indexOf('--task') + 1]
assert.match(task ?? '', /^T-0(?:0[1-9]|1[0-7])$/, 'An exact implemented File format task is required.')
const integration = task === 'T-017' && !process.argv.includes('--mutations-only')
if (integration) assert.ok(process.env.AGENTMUX_EDITOR_FORMAT_EVIDENCE && process.env.AGENTMUX_MUTATION_RECEIPTS,
  'Integration acceptance requires explicit native, independent visual, production bundle and exact mutation evidence.')
if (task !== 'T-001') {
  const definition = await import(`./file-format-checks/${task}.mjs`)
  assert.ok(definition.tests?.length && definition.sources?.length && definition.mutations?.length, 'Every task needs consumer tests and real production mutations.')
  await verifyRendererSourceMutations({ name: `file-formats-${task}`, ...definition })
} else await verifyRendererSourceMutations({
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
if (integration) await (await import('./verify-file-format-integration-evidence.mjs')).verifyIntegrationEvidence()
