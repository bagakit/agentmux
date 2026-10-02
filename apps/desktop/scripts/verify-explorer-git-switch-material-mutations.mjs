import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const dock = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
await verifyRendererSourceMutations({
  name: ("explorer-git-switch-material-" + (globalThis.crypto.randomUUID()) + ""),
  tests: ['apps/desktop/test/explorer-git-switch-material.test.tsx'],
  sources: [dock, 'apps/desktop/src/renderer/src/components/settings/LiquidSelectionSurface.tsx',
    'apps/desktop/src/renderer/src/styles/source-control.css', 'apps/desktop/src/renderer/src/styles/settings-materials.css',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'decorative-product-mount', file: dock,
      before: '<LiquidSelectionSurface selected={bottomView} active={visible} targetAttribute="data-git-view" />',
      after: '<span aria-hidden="true" />' },
    { label: 'actual-dock-visibility', file: dock,
      before: 'selected={bottomView} active={visible} targetAttribute="data-git-view"',
      after: 'selected={bottomView} active={true} targetAttribute="data-git-view"' },
    { label: 'native-selection-owner', file: dock,
      before: 'selected={bottomView} active={visible} targetAttribute="data-git-view"',
      after: 'selected="branches" active={visible} targetAttribute="data-git-view"' },
    { label: 'material-style-consumer', file: dock,
      before: 'className="source-control-switch" role="tablist"',
      after: 'className="source-control-unskinned" role="tablist"' }
  ]
})
