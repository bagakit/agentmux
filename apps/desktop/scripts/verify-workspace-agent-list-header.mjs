import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const component = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
await verifyRendererSourceMutations({
  name: 'workspace-agent-list-header',
  tests: ['apps/desktop/test/space-agent-list-management.test.tsx', 'apps/desktop/test/space-agent-contexts.test.tsx'],
  sources: [component, 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/agent-information-root.tsx',
    'apps/desktop/test/helpers/styles.ts', 'apps/desktop/scripts/lib/fixture-values.mjs'],
  mutations: [
    { label: 'header-focus-action-must-reach-original-owner', file: component,
      before: "onClick={() => openFocus('agents')}", after: 'onClick={() => undefined}' },
    { label: 'header-selection-action-must-enter-management', file: component,
      before: 'setSelecting(value => !value)', after: 'setSelecting(value => value)' },
    { label: 'header-state-filter-must-change-visible-scope', file: component,
      before: 'onClick={() => setFilter(bucket)}', after: "onClick={() => setFilter('all')}" }
  ]
})
