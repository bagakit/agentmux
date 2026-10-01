import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const desktop = 'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx'
const shared = 'packages/client-ui/src/components/ConversationInputDetails.tsx'
await verifyRendererSourceMutations({
  name: ("explorer-sender-platform-" + (globalThis.crypto.randomUUID()) + "-" + (randomUUID().slice(0, 8)) + ""),
  tests: ['apps/desktop/test/project-path-metadata-consumers.test.tsx'],
  sources: [desktop, shared, 'packages/client-ui/src/platform.tsx', 'packages/client-ui/package.json',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'desktop-project-path-preference', file: desktop,
      before: 'title={displayPath(project.path, hostId)}', after: 'title={project.path}' },
    { label: 'shared-project-label-consumer', file: shared,
      before: 'platform.renderProjectLabel(details.project)',
      after: '<small title={details.project.path}>{details.project.name}</small>' }
  ]
})
