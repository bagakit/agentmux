import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const store = 'apps/desktop/src/renderer/src/store.ts'
const spatial = 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts'
await verifyRendererSourceMutations({
  name: 'topic-content-identity', owningConfig: 'apps/desktop/test/topic-content-identity.config.mts',
  tests: ['apps/desktop/test/topic-knowledge-ui.test.tsx', 'apps/desktop/test/topic-category-spatial.test.ts'],
  sources: [store, spatial, 'apps/desktop/src/shared/space-addresses.ts',
    'apps/desktop/test/helpers/topic-spatial-client-fixture.ts', 'apps/desktop/test/vitest.mote-context.config.mts',
    'apps/desktop/scripts/verify-topic-content-identity.mjs', 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/host/src/topic-spatial-owner.ts', 'apps/host/src/topic-knowledge.ts', 'vitest.config.ts', 'vitest.dist-freshness.ts'],
  mutations: [
    { label: 'creation-keeps-content-identity', file: store,
      before: 'return { tabs: { ...current.tabs, [live.id]: { ...live, space: originalTopicAddress(workspace, snapshot, current.spaceZoneBindings)! } },',
      after: 'return { tabs: { ...current.tabs, [live.id]: { ...live, space: address } },' },
    { label: 'discussion-keeps-content-identity', file: store,
      before: '{ ...current.tabs[tab.id]!, space: originalTopicAddress(workspace, snapshot, current.spaceZoneBindings)! }',
      after: '{ ...current.tabs[tab.id]!, space: address }' },
    { label: 'original-zone-owns-hydrated-content', file: spatial,
      before: '...(contentSpaceId ? { spaceId: contentSpaceId } : {}), zoneId: fact.zoneId',
      after: 'zoneId: fact.zoneId' },
    { label: 'placeholder-precedes-host-registration', file: store,
      before: '      if (initialRequest) await coreSpatialPersistence?.flush()',
      after: '      // Mutation: Host registration races the pending placeholder.' }
  ]
})
