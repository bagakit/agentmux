import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const panel = 'apps/desktop/src/renderer/src/components/ChangesPanel.tsx'
await verifyRendererSourceMutations({
  name: 'explorer-changes-mutations',
  tests: ['apps/desktop/test/changes-panel.test.tsx', 'apps/desktop/test/explorer-redesign.test.tsx'],
  sources: [panel, 'apps/desktop/src/renderer/src/styles/source-control.css',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'compact-state-rendering', file: panel,
      before: '{CHANGE_MARK[gitChangeClass(change)]}', after: '{label}' },
    { label: 'focused-stage-action', file: panel,
      before: 'onClick={() => void stageFile(change)}', after: 'onClick={() => undefined}' }
  ]
})
