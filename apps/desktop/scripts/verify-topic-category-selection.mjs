import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

process.env.NODE_NO_WARNINGS = '1'
const navigation = 'apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts'
const persistence = 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
await verifyRendererSourceMutations({
  name: 'topic-category-selection',
  owningConfig: 'apps/desktop/test/topic-category-selection.config.mts',
  ...(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT ? { evidenceRoot: resolve(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT) } : {}),
  tests: ['apps/desktop/test/topic-category-selection.test.ts'],
  sources: [navigation, persistence, store, 'apps/desktop/src/renderer/src/lib/topic-knowledge-actions.ts',
    'apps/desktop/scripts/verify-topic-category-selection.mjs', 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/desktop/test/helpers/topic-spatial-client-fixture.ts',
    'apps/desktop/test/vitest.mote-context.config.mts', 'vitest.config.ts', 'vitest.dist-freshness.ts'],
  mutations: [
    { label: 'public-transfer-common-apply', file: store,
      before: 'const workbenchSpaceSelection=reconcileWorkbenchSpaceSelection(current.workbenchSpaceSelection,baseline,saved.graph)',
      after: 'const workbenchSpaceSelection=current.workbenchSpaceSelection' },
    { label: 'classification-requires-unique-category', file: navigation,
      before: 'if (destinations.length !== 1 || destinations[0]!.readError) return choice',
      after: 'if (destinations.length < 1 || destinations[0]!.readError) return choice' },
    { label: 'unknown-membership-keeps-original-workface', file: navigation,
      before: "? projectWorkbenchProjection(layout, tabs, { entity: { kind: 'zone', zoneId: zone.zoneId },",
      after: "? projectWorkbenchProjection(layout, tabs, { entity: { kind: 'tab', tabId: reference.tabId }," },
    { label: 'explicit-refresh-uses-same-observation', file: persistence,
      before: '    this.observe(state);\n  }\n  private observe',
      after: '    void state;\n  }\n  private observe' },
    { label: 'resource-read-does-not-consume-applied-frontier', file: persistence,
      before: 'if (this.state && state.revision < this.state.revision || this.applied && state.revision <= this.applied.revision)',
      after: 'if (this.state && state.revision <= this.state.revision)' },
    { label: 'local-edit-keeps-original-applied-baseline', file: persistence,
      before: 'this.pending = { graph, baseline: this.pending?.baseline ?? this.applied ?? this.state! };',
      after: 'this.pending = { graph, baseline: this.state! };' },
    { label: 'unknown-category-keeps-exact-local-focus', file: navigation,
      before: "if (regionId && state.tabs[reference.tabId]?.regions[regionId] && workbenchProjectionLocationsMatchOwner(catalog, reference.tabId, locations))",
      after: 'if (false)' }
  ]
})
