import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const modes = 'apps/desktop/src/renderer/src/components/SurfaceModeSwitch.tsx'
const project = 'apps/desktop/src/renderer/src/components/ProjectFilesTool.tsx'
await verifyRendererSourceMutations({
  name: ("explorer-git-switch-material-" + (globalThis.crypto.randomUUID()) + ""),
  tests: ['apps/desktop/test/explorer-git-switch-material.test.tsx'],
  sources: [modes, project, 'apps/desktop/src/renderer/src/components/LiquidSelectionSurface.tsx',
    'apps/desktop/src/renderer/src/styles/surface-mode-switch.css', 'apps/desktop/src/renderer/src/styles/liquid-selection.css',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'decorative-product-mount', file: modes,
      before: '<LiquidSelectionSurface selected={value} active={active} targetAttribute="data-surface-mode" />',
      after: '<span aria-hidden="true" />' },
    { label: 'actual-dock-visibility', file: project,
      before: 'value={view} options={VIEWS} onChange={setView} active={visible}',
      after: 'value={view} options={VIEWS} onChange={setView} active={true}' },
    { label: 'native-selection-owner', file: modes,
      before: 'selected={value} active={active} targetAttribute="data-surface-mode"',
      after: 'selected="branches" active={active} targetAttribute="data-surface-mode"' },
    { label: 'material-style-consumer', file: modes,
      before: 'className="surface-mode-switch" role="tablist"',
      after: 'className="surface-mode-unskinned" role="tablist"' }
  ]
})
