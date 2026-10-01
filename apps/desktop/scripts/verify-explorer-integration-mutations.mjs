import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const file = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
await verifyRendererSourceMutations({
  name: ("explorer-integration-" + (globalThis.crypto.randomUUID()) + "-" + (randomUUID().slice(0, 8)) + ""),
  tests: ['apps/desktop/test/explorer-redesign.integration.test.tsx'],
  sources: [file, 'apps/desktop/src/renderer/src/components/GitHistoryPanel.tsx', 'apps/desktop/src/renderer/src/components/FileExplorer.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [{ label: 'history-product-mount', file,
    before: '<GitHistoryPanel workspace={workspace} history={history} />',
after: '<div aria-label="Detached History projection" />' },
    { label: 'actual-merge-geometry', file: 'apps/desktop/src/renderer/src/components/GitHistoryPanel.tsx',
      before: '${x(after.indexOf(parent))} ${bottom}`} />',
      after: '${x(lane)} ${bottom}`} />' },
    { label: 'rename-initial-selection', file: 'apps/desktop/src/renderer/src/components/FileExplorer.tsx',
      before: 'input.setSelectionRange(0, extension > 0 ? extension : node.name.length)',
      after: 'input.setSelectionRange(node.name.length, node.name.length)' }]
})
