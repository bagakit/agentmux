import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const component = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
const membership = 'apps/desktop/src/renderer/src/lib/surface-tool-dock.ts'
const index = 'apps/desktop/src/renderer/src/lib/session-presentation.ts'
await verifyRendererSourceMutations({
  name: 'space-agent-list-relevance',
  owningConfig: 'apps/desktop/test/vitest.context-hover.config.mts',
  tests: ['apps/desktop/test/space-agent-list-performance.test.tsx'],
  sources: [component, membership, index, 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/agent-information-root.tsx',
    'apps/desktop/scripts/lib/fixture-values.mjs', 'test/fixture-values.mjs'],
  mutations: [
    { label: 'list-must-not-filter-global-sessions-per-publication', file: membership,
      before: 'const candidates = [...directories].flatMap(path => sessionPresentationsAtPath(sessions, workspace.hostId, path))',
      after: 'const candidates = sessions.filter(session => session.hostId === workspace.hostId)' },
    { label: 'local-goal-projection-must-not-consume-unrelated-sessions', file: component,
      before: 'goalSelector({ demands: state.demands, sessions: scoped }, active)', after: 'goalSelector(state, active)' },
    { label: 'directory-consumers-must-share-original-index', file: index,
      before: 'let indexed = pathIndexes.get(sessions)', after: 'let indexed: SessionPaths | undefined' },
    { label: 'member-selector-must-refresh-original-facts', file: membership,
      before: 'if (nextInputs.every((value, index) => value === inputs[index])) return selected',
      after: 'if (inputs.length) return selected' }
  ]
})
