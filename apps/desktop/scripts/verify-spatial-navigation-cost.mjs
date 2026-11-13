import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const evidence = process.argv.indexOf('--evidence')
const navigation = 'apps/desktop/src/renderer/src/lib/workbench-navigation-catalog.ts'
await verifyRendererSourceMutations({ name: 'spatial-navigation-cost',
  evidenceRoot: evidence < 0 ? undefined : resolve(process.argv[evidence + 1]),
  owningConfig: 'apps/desktop/test/vitest.spatial-navigation-cost.config.mts',
  tests: ['apps/desktop/test/spatial-navigation-cost.test.tsx'],
  sources: ['vitest.config.ts', 'test/fixture-values.mjs', 'apps/desktop/test/vitest.mote-context.config.mts',
    'apps/desktop/scripts/verify-spatial-navigation-cost.mjs', 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    navigation, 'apps/desktop/src/shared/space-addresses.ts', 'apps/desktop/src/renderer/src/lib/space-agent-control.ts',
    'apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
    'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', 'apps/desktop/src/renderer/src/components/FocusProjectLanes.tsx',
    'apps/desktop/src/renderer/src/lib/use-focus-collection-lanes.ts', 'apps/desktop/src/renderer/src/lib/focus-collection-lanes.ts',
    'apps/desktop/src/renderer/src/components/FocusLaneHeadingMenu.tsx',
    'apps/desktop/src/renderer/src/lib/use-focus-context-placements.ts',
    'apps/desktop/src/renderer/src/components/FocusScanLaneContent.tsx', 'apps/desktop/src/renderer/src/components/FocusLaneGroups.tsx',
    'apps/desktop/src/renderer/src/components/FocusContextRow.tsx', 'apps/desktop/src/renderer/src/styles/focus.css',
    'apps/desktop/src/renderer/src/components/AgentContextContent.tsx',
    'apps/desktop/src/renderer/src/lib/scratch-topic-snapshots.ts', 'apps/host/src/topic-categories.ts',
    'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/fixtures/mote-workface.ts', 'apps/desktop/scripts/lib/fixture-values.mjs'],
  mutations: [
    { label: 'unrelated-navigation-rebuilds-classification-seeds', file: navigation,
      before: 'const value = spatialCatalog({ ...state, tabs, sessions: [] }, topicFacts, categorySeeds.value)',
      after: 'const value = spatialCatalog({ ...state, tabs, sessions: [] }, topicFacts)' },
    { label: 'related-category-order-keeps-stale-membership-seeds', file: navigation,
      before: 'categorySeeds.categories !== categories', after: 'false' }
  ] })
