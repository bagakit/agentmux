import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const panel = 'apps/desktop/src/renderer/src/features/git/history/GitHistoryPanel.tsx'
const details = 'apps/desktop/src/renderer/src/features/git/history/GitHistoryDetails.tsx'
const hook = 'apps/desktop/src/renderer/src/features/git/history/useGitHistory.ts'
await verifyRendererSourceMutations({
  name: ("git-history-scroll-hover-" + (globalThis.crypto.randomUUID()) + ""),
  tests: ['apps/desktop/test/git-history-scroll-hover.test.tsx'],
  sources: [panel, details, hook,
    'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx',
    'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx',
    'apps/desktop/src/renderer/src/lib/git-bridge.ts',
    'apps/desktop/src/renderer/src/styles/git-history.css',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'scroll-production-consumer', file: panel,
      before: 'ROW_HEIGHT * 8)) void history.loadMore()', after: 'ROW_HEIGHT * 8)) void 0' },
    { label: 'automatic-failure-retry', file: panel,
      before: 'history.loading || history.error || !ready?.nextCursor) return\n    if (view.scrollHeight',
      after: 'history.loading || !ready?.nextCursor) return\n    if (view.scrollHeight' },
    { label: 'visible-owner-consumer', file: hook,
      before: 'const enabled = visible && documentVisible', after: 'const enabled = true' },
    { label: 'explicit-retry-pinned-cursor', file: panel,
      before: 'ready?.nextCursor ? history.loadMore() : history.refresh()', after: 'history.refresh()' },
    { label: 'complete-parents', file: details,
      before: 'opened.commit.parents.map(parent =>', after: 'opened.commit.parents.slice(0, 1).map(parent =>' },
    { label: 'complete-reference-facts', file: details,
      before: 'opened.commit.refs.map(ref =>', after: 'opened.commit.refs.slice(0, 2).map(ref =>' },
    { label: 'dismissed-position-result', file: details,
      before: 'if (disposed || request !== revision || !opened.anchor.isConnected) return',
      after: 'if (!opened.anchor.isConnected) return' }
  ]
})
