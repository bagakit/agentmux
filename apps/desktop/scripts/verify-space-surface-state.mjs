import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const components = 'apps/desktop/src/renderer/src/components/'
const surface = components + 'SurfaceState.tsx'
const workbench = components + 'WorkspaceWorkbench.tsx'
const loading = components + 'FullPageLoadingSurface.tsx'
const launcher = components + 'NewTabSurface.tsx'

await verifyRendererSourceMutations({
  name: 'space-surface-state',
  tests: [
    'apps/desktop/test/space-surface-state.test.tsx',
    'apps/desktop/test/topic-empty-workbench.test.tsx',
    'apps/desktop/test/full-page-loading-surface.test.tsx',
    'apps/desktop/test/full-page-loading-wait.test.tsx'
  ],
  sources: [
    surface, workbench, loading, launcher,
    components + 'ServiceWindowNotice.tsx', components + 'WorkbenchEmptyState.tsx',
    components + 'ServiceNoticeDisclosure.tsx', components + 'StableWorkbenchView.tsx',
    'apps/desktop/src/renderer/src/lib/workbench-projection.ts',
    'apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts',
    'apps/desktop/src/renderer/src/styles/surface-state.css',
    'apps/desktop/src/renderer/src/styles/workbench.css',
    'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/fixtures/mote-workface.ts',
    'apps/desktop/scripts/lib/fixture-values.mjs',
    'test/fixture-values.mjs'
  ],
  mutations: [
    { label: 'custom-body-swallows-heading', file: surface,
      before: 'eyebrow != null || title != null || description != null ? <div',
      after: 'body == null && (eyebrow != null || title != null || description != null) ? <div' },
    { label: 'shared-actions-disconnected', file: surface,
      before: '{actions != null ? <div className="surface-state__actions">{actions}</div> : null}',
      after: '{false ? <div className="surface-state__actions">{actions}</div> : null}' },
    { label: 'unknown-workface-collapses-to-inline', file: workbench,
      before: 'const projectionState = projectionIssue ? <ServiceWindowNotice notice={projectionIssue} layout="surface" /> : null',
      after: 'const projectionState = projectionIssue ? <ServiceWindowNotice notice={projectionIssue} layout="inline" /> : null' },
    { label: 'parked-observation-invents-waiting', file: loading,
      before: "const busy = phase === 'loading' || phase === 'recovering'",
      after: "const busy = phase === 'loading' || phase === 'recovering' || phase === 'parked'" },
    { label: 'launcher-input-inherits-live-status', file: launcher,
      before: '<SurfaceState ref={surfaceRef} className="launch-surface"',
      after: '<SurfaceState role="status" ref={surfaceRef} className="launch-surface"' },
    { label: 'retained-body-dropped-with-location-gap', file: workbench,
      before: 'const bodyLayout = retainUnplacedTab ? lastConfirmedBody.current?.layout ?? null : layout',
      after: 'const bodyLayout = retainUnplacedTab ? null : layout' }
  ]
})
